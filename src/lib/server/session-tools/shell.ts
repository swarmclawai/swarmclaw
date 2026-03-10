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
  type SandboxOptions,
} from '@/lib/server/runtime/process-manager'
import { detectDocker } from '@/lib/server/sandbox/docker-detect'
import type { ToolBuildContext } from './context'
import { safePath, truncate, coerceEnvMap, MAX_OUTPUT } from './context'
import { checkFileAccess } from './file-access-policy'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { safeJsonParseObject } from '../json-utils'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'

function resolveShellWorkdir(baseCwd: string, requestedWorkdir?: string): string {
  const raw = typeof requestedWorkdir === 'string' ? requestedWorkdir.trim() : ''
  if (!raw) return baseCwd
  try {
    const resolved = safePath(baseCwd, raw)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved
  } catch { /* ignore */ }
  return safePath(baseCwd, raw)
}

export function rewriteShellWorkspaceAliases(baseCwd: string, command: string): string {
  const cwd = typeof baseCwd === 'string' ? baseCwd.trim() : ''
  if (!cwd) return command

  let rewritten = command
  rewritten = rewritten.replace(/(^|[\s"'`(=;])\/workspace(?=\/|\b)/g, `$1${cwd}`)
  rewritten = rewritten.replace(/(^|[\s"'`(=;])workspace\//g, `$1${cwd}/`)
  return rewritten
}

export function stripManagedBackgroundSuffix(command: string): string {
  return command.replace(/\s*&\s*$/, '').trim()
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
  return typeof raw === 'string' ? safeJsonParseObject(raw) : asRecord(raw)
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
 * Extract file path operands from common shell commands.
 * Covers cat, rm, cp, mv, tee, and redirections (>, >>).
 * Returns best-effort paths — won't catch variable expansion or complex pipelines.
 */
function extractShellFileTargets(command: string): string[] {
  const paths: string[] = []
  // Redirect targets: > /path or >> /path
  for (const m of command.matchAll(/>{1,2}\s*([^\s;|&]+)/g)) {
    if (m[1] && !m[1].startsWith('-')) paths.push(m[1])
  }
  // tee [flags] <path>
  for (const m of command.matchAll(/\btee\s+(?:-[a-zA-Z]+\s+)*([^\s;|&]+)/g)) {
    if (m[1] && !m[1].startsWith('-')) paths.push(m[1])
  }
  // cat/rm/cp/mv operands (skip flags starting with -)
  for (const m of command.matchAll(/\b(?:cat|rm|cp|mv)\s+((?:(?:-[a-zA-Z]+\s+)*)(.+?))\s*(?:[;|&]|$)/g)) {
    const argsStr = m[1] || ''
    for (const token of argsStr.split(/\s+/)) {
      if (token && !token.startsWith('-')) paths.push(token)
    }
  }
  return paths
}

/**
 * Check shell command file targets against file access policy.
 * Returns an error string if any path is blocked, null otherwise.
 */
function checkShellFileAccessPolicy(
  command: string,
  cwd: string,
  policy: { allowedPaths?: string[]; blockedPaths?: string[] } | null | undefined,
): string | null {
  if (!policy) return null
  const targets = extractShellFileTargets(command)
  for (const target of targets) {
    const result = checkFileAccess(target, cwd, policy)
    if (!result.allowed) {
      return `Shell command blocked: ${result.reason}`
    }
  }
  return null
}

/**
 * Unified Shell Execution Logic
 */
function resolveSandboxOptions(
  cwd: string,
  config: { enabled: boolean; image?: string; network?: 'none' | 'bridge'; memoryMb?: number; cpus?: number; readonlyRoot?: boolean } | null | undefined,
): SandboxOptions | undefined {
  if (!config?.enabled) return undefined
  const docker = detectDocker()
  if (!docker.available) {
    throw new Error('Sandbox is enabled but Docker is not available. Install Docker Desktop or disable the sandbox in agent settings.')
  }
  return {
    image: config.image || 'node:22-slim',
    network: config.network || 'none',
    memoryMb: config.memoryMb || 512,
    cpus: config.cpus || 1.0,
    readonlyRoot: config.readonlyRoot || false,
    workspaceMounts: [{ hostPath: cwd, containerPath: '/workspace' }],
  }
}

async function executeShellAction(
  args: Record<string, unknown>,
  bctx: {
    cwd: string
    agentId?: string | null
    sessionId?: string | null
    fileAccessPolicy?: { allowedPaths?: string[]; blockedPaths?: string[] } | null
    sandboxConfig?: { enabled: boolean; image?: string; network?: 'none' | 'bridge'; memoryMb?: number; cpus?: number; readonlyRoot?: boolean } | null
  },
) {
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
        // Enforce file access policy on shell command targets
        const policyDenial = checkShellFileAccessPolicy(command, bctx.cwd, bctx.fileAccessPolicy)
        if (policyDenial) return policyDenial
        const rewrittenCommand = rewriteShellWorkspaceAliases(bctx.cwd, command)
        const effectiveBackground = !!background || (typeof rewrittenCommand === 'string' && isLikelyServerCommand(rewrittenCommand))
        const managedCommand = effectiveBackground ? stripManagedBackgroundSuffix(rewrittenCommand) : rewrittenCommand
        const envMap = coerceEnvMap(env) || {}
        if (!envMap.WORKSPACE) envMap.WORKSPACE = bctx.cwd
        if (!envMap.SESSION_CWD) envMap.SESSION_CWD = bctx.cwd
        let sandbox: SandboxOptions | undefined
        try {
          sandbox = resolveSandboxOptions(bctx.cwd, bctx.sandboxConfig)
        } catch (err: unknown) {
          return `Error: ${errorMessage(err)}`
        }
        const result = await startManagedProcess({
          command: managedCommand,
          cwd: resolveShellWorkdir(bctx.cwd, workdir),
          env: envMap,
          agentId: bctx.agentId || null,
          sessionId: bctx.sessionId || null,
          background: effectiveBackground,
          timeoutMs: typeof timeoutSec === 'number' ? timeoutSec * 1000 : 30000,
          sandbox,
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
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const ShellPlugin: Plugin = {
  name: 'Core Shell',
  description: 'Execute shell commands and manage background processes.',
  hooks: {
    getCapabilityDescription: () => 'I can run shell commands with the unified `shell` tool. Use action `execute` for commands, and `list` / `status` / `poll` / `log` for long-lived processes.',
    getOperatingGuidance: () => ['Shell: use `shell` with `{"action":"execute","command":"..."}` for servers, installs, scripts, and git. Use `background=true` for long-lived processes.', 'Verify servers with `shell` status/log actions and liveness probes before claiming success.', 'Resolve IPs/URLs via shell — never use placeholders. Retry path errors without workdir override.'],
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
      async (args) => executeShellAction(args, { ...bctx.ctx, cwd: bctx.cwd, fileAccessPolicy: bctx.fileAccessPolicy, sandboxConfig: bctx.sandboxConfig }),
      {
        name: 'shell',
        description: ShellPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
