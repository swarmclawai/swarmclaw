import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import fs from 'fs'
import {
  getManagedProcess,
  killManagedProcess,
  listManagedProcesses,
  pollManagedProcess,
  readManagedProcessLog,
  removeManagedProcess,
  startManagedProcess,
  writeManagedProcessStdin,
} from '../process-manager'
import type { ToolBuildContext } from './context'
import { safePath, truncate, coerceEnvMap, MAX_OUTPUT } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

function resolveShellWorkdir(baseCwd: string, requestedWorkdir?: string): string {
  const raw = typeof requestedWorkdir === 'string' ? requestedWorkdir.trim() : ''
  if (!raw) return baseCwd
  try {
    const resolved = safePath(baseCwd, raw)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved
  } catch { /* ignore */ }
  return safePath(baseCwd, raw)
}

function isLikelyServerCommand(command: string): boolean {
  const cmd = command.trim()
  return /\bnpm\s+run\s+(dev|start|serve)\b/.test(cmd) || 
         /\bnpx\s+(serve|next|vite|nuxt|astro)\b/.test(cmd) ||
         /\bpython3?\s+-m\s+http\.server\b/.test(cmd)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseNestedInput(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw))
    } catch {
      return null
    }
  }
  return asRecord(raw)
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return undefined
}

export function normalizeShellArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const base = normalizeToolInputArgs(rawArgs)
  const nested = parseNestedInput(base.input)

  const command = pickString(
    base.command,
    base.cmd,
    base.execute_command,
    nested?.command,
    nested?.cmd,
    nested?.execute_command,
  )
  const action = pickString(base.action, nested?.action) ?? (command ? 'execute' : undefined)

  return {
    action,
    command,
    processId: pickString(base.processId, base.process_id, nested?.processId, nested?.process_id),
    background: pickBoolean(base.background, nested?.background),
    workdir: pickString(base.workdir, base.cwd, nested?.workdir, nested?.cwd),
    env: asRecord(base.env) || asRecord(nested?.env),
    timeoutSec: pickNumber(base.timeoutSec, base.timeout, nested?.timeoutSec, nested?.timeout),
    data: pickString(base.data, base.stdin, nested?.data, nested?.stdin),
    signal: pickString(base.signal, base.killSignal, nested?.signal, nested?.killSignal),
    offset: pickNumber(base.offset, nested?.offset),
    limit: pickNumber(base.limit, nested?.limit),
  }
}

/**
 * Unified Shell Execution Logic
 */
async function executeShellAction(args: Record<string, unknown>, bctx: { cwd: string; agentId?: string | null; sessionId?: string | null }) {
  const normalized = normalizeShellArgs(args)
  const action = normalized.action as string | undefined
  const command = normalized.command as string | undefined
  const processId = normalized.processId as string | undefined
  const background = normalized.background as boolean | undefined
  const workdir = normalized.workdir as string | undefined
  const env = normalized.env
  const timeoutSec = normalized.timeoutSec as number | undefined
  const data = normalized.data as string | undefined
  const signal = normalized.signal as string | undefined
  const offset = normalized.offset as number | undefined
  const limit = normalized.limit as number | undefined
  try {
    switch (action) {
      case 'execute': {
        if (!command) return 'Error: command or cmd is required for execute action.'
        const effectiveBackground = !!background || (typeof command === 'string' && isLikelyServerCommand(command))
        const result = await startManagedProcess({
          command: command,
          cwd: resolveShellWorkdir(bctx.cwd, workdir),
          env: coerceEnvMap(env),
          agentId: bctx.agentId || null,
          sessionId: bctx.sessionId || null,
          background: effectiveBackground,
          timeoutMs: typeof timeoutSec === 'number' ? timeoutSec * 1000 : 30000,
        })
        if (result.status === 'completed') return truncate(result.output || '(no output)', MAX_OUTPUT)
        return JSON.stringify({ status: 'running', processId: result.processId, tail: result.tail || '' }, null, 2)
      }
      case 'list': return JSON.stringify(listManagedProcesses(bctx.agentId || null), null, 2)
      case 'status': return JSON.stringify(getManagedProcess(processId!) || `Not found: ${processId}`, null, 2)
      case 'poll': return JSON.stringify(pollManagedProcess(processId!) || `Not found: ${processId}`, null, 2)
      case 'log': return JSON.stringify(readManagedProcessLog(processId!, offset, limit) || `Not found: ${processId}`, null, 2)
      case 'write': return writeManagedProcessStdin(processId!, data || '', false).ok ? `Wrote to ${processId}` : `Error`
      case 'kill': {
        const killSignal = (typeof signal === 'string' && signal.trim() ? signal : 'SIGTERM') as NodeJS.Signals
        return killManagedProcess(processId!, killSignal).ok ? `Killed ${processId}` : `Error`
      }
      case 'remove': return removeManagedProcess(processId!).ok ? `Removed ${processId}` : `Error`
      default: return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const ShellPlugin: Plugin = {
  name: 'Core Shell',
  description: 'Execute shell commands and manage background processes.',
  hooks: {
    getCapabilityDescription: () => 'I can run shell commands (`execute_command`) — servers, installs, scripts, git, builds, anything. I can run things in the background for long-lived processes like dev servers.',
    getOperatingGuidance: () => ['Shell: use `execute_command` for servers, installs, scripts, git. Use `background=true` for long-lived processes.', 'Verify servers with `process_tool` status/log and liveness probes before claiming success.', 'Resolve IPs/URLs via shell — never use placeholders. Retry path errors without workdir override.'],
  } as PluginHooks,
  tools: [
    {
      name: 'shell',
      description: 'Execute commands and manage processes.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['execute', 'list', 'status', 'poll', 'log', 'write', 'kill', 'remove'] },
          command: { type: 'string' },
          processId: { type: 'string' },
          background: { type: 'boolean' },
        },
        required: ['action']
      },
      execute: async (args, context) => executeShellAction(args, { ...context.session, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('shell', ShellPlugin)

export function buildShellTools(bctx: ToolBuildContext) {
  if (!bctx.hasPlugin('shell')) return []
  return [
    tool(
      async (args) => executeShellAction(args, { ...bctx.ctx, cwd: bctx.cwd }),
      {
        name: 'shell',
        description: ShellPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
