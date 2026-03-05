import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { spawn, spawnSync } from 'child_process'
import type { ToolBuildContext } from './context'
import { truncate, findBinaryOnPath, MAX_OUTPUT } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

const MAX_DELEGATION_CHAIN_HOPS = 128

interface DelegateContext {
  cwd?: string
  claudeTimeoutMs?: number
  readStoredDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini') => string | null
  persistDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini', id: string) => void
  ctx?: { platformAssignScope?: string; agentId?: string | null }
  hasPlugin?: (name: string) => boolean
  /** @deprecated Use hasPlugin */
  hasTool?: (name: string) => boolean
}

type DelegateBackend = 'claude' | 'codex' | 'opencode' | 'gemini'

function asTaskRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const int = Math.trunc(value)
  return int >= 0 ? int : null
}

function _computeDelegationDepth(
  task: Record<string, unknown> | null,
  tasksById: Record<string, unknown>,
): number {
  if (!task) return 0
  const explicitDepth = parseNonNegativeInt(task.delegationDepth)
  if (explicitDepth !== null) return explicitDepth
  if (task.sourceType !== 'delegation') return 0

  let depth = 1
  let parentId = typeof task.delegatedFromTaskId === 'string' ? task.delegatedFromTaskId.trim() : ''
  let hops = 0
  const visited = new Set<string>()

  while (parentId && hops < MAX_DELEGATION_CHAIN_HOPS && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = asTaskRecord(tasksById[parentId])
    if (!parent) break
    const parentExplicitDepth = parseNonNegativeInt(parent.delegationDepth)
    if (parentExplicitDepth !== null) {
      depth = Math.max(depth, parentExplicitDepth + 1)
      break
    }
    depth++
    parentId = typeof parent.delegatedFromTaskId === 'string' ? parent.delegatedFromTaskId.trim() : ''
    hops++
  }

  return depth
}

/**
 * Core Delegate Execution Logic
 */
async function executeDelegateAction(args: Record<string, unknown>, bctx: DelegateContext) {
  const normalized = normalizeToolInputArgs(args)
  const task = normalized.task as string
  const backend = ((normalized.backend as string) || 'claude') as DelegateBackend
  const resume = normalized.resume as boolean
  const resumeId = normalized.resumeId as string
  const backends = {
    claude: findBinaryOnPath('claude'),
    codex: findBinaryOnPath('codex'),
    opencode: findBinaryOnPath('opencode'),
    gemini: findBinaryOnPath('gemini'),
  }
  const binary = backends[backend as keyof typeof backends]
  if (!binary) return `Error: Backend "${backend}" unavailable.`

  if (backend === 'claude') return runClaudeDelegate(binary, task, resume, resumeId, bctx)
  if (backend === 'codex') return runCodexDelegate(binary, task, resume, resumeId, bctx)
  if (backend === 'opencode') return runOpenCodeDelegate(binary, task, resume, resumeId, bctx)
  if (backend === 'gemini') return runGeminiDelegate(binary, task, resume, resumeId, bctx)
  return `Error: Unsupported backend "${backend}".`
}

function stripEnvPrefixes(input: NodeJS.ProcessEnv, prefixes: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...input }
  for (const key of Object.keys(out)) {
    const upper = key.toUpperCase()
    if (prefixes.some((prefix) => upper.startsWith(prefix))) delete out[key]
  }
  return out
}

function parseCodexOutputText(ev: Record<string, unknown>): string | null {
  if (ev.type === 'item.content_part.delta') {
    const delta = ev.delta as Record<string, unknown> | undefined
    if (typeof delta?.text === 'string') return delta.text
  }
  if (ev.type === 'item.completed') {
    const item = ev.item as Record<string, unknown> | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
    if (item?.type === 'message' && item?.role === 'assistant') {
      const content = item.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const parts = content
          .filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'output_text')
          .map((entry) => String((entry as Record<string, unknown>).text || ''))
        const joined = parts.join('')
        if (joined) return joined
      }
    }
  }
  return null
}

async function runCodexDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext): Promise<string> {
  try {
    const env = stripEnvPrefixes({ ...process.env, TERM: 'dumb', NO_COLOR: '1' }, ['CODEX'])
    const authProbe = spawnSync(binary, ['login', 'status'], { cwd: bctx.cwd, env, encoding: 'utf-8', timeout: 8000 })
    const probeText = `${authProbe.stdout || ''}\n${authProbe.stderr || ''}`.toLowerCase()
    const loggedIn = probeText.includes('logged in')
    if ((authProbe.status ?? 1) !== 0 || !loggedIn) {
      return 'Error: Codex CLI is not authenticated. Run `codex login` and retry.'
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('codex')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<string>((resolve) => {
      const args: string[] = ['exec']
      if (resumeIdToUse) args.push('resume', resumeIdToUse)
      args.push('--json', '--full-auto', '--skip-git-repo-check', '-')

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (text: string) => {
        if (settled) return
        settled = true
        resolve(truncate(text, MAX_OUTPUT))
      }

      const timeoutHandle = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }, bctx.claudeTimeoutMs || 300000)

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>
            if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') discoveredId = ev.thread_id
            const parsedText = parseCodexOutputText(ev)
            if (parsedText) responseText = parsedText
          } catch {
            responseText += `${line}\n`
          }
        }
      })

      child.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString()
        if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-16_000)
      })

      child.on('close', (code, signal) => {
        clearTimeout(timeoutHandle)
        if (discoveredId) bctx.persistDelegateResumeId?.('codex', discoveredId)
        const output = responseText.trim()
        if (output) return finish(output)
        const stderr = stderrBuf.trim()
        if (stderr) return finish(`Error: ${stderr}`)
        return finish(`Error: Codex exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`)
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(`Error: ${err.message}`)
      })

      child.stdin?.write(task)
      child.stdin?.end()
    })
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function runOpenCodeDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext): Promise<string> {
  try {
    const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
    const storedResumeId = bctx.readStoredDelegateResumeId?.('opencode')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<string>((resolve) => {
      const args = ['run', task, '--format', 'json']
      if (resumeIdToUse) args.push('--session', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (text: string) => {
        if (settled) return
        settled = true
        resolve(truncate(text, MAX_OUTPUT))
      }

      const timeoutHandle = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }, bctx.claudeTimeoutMs || 300000)

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>
            const sid = typeof ev.sessionID === 'string' ? ev.sessionID : (typeof ev.sessionId === 'string' ? ev.sessionId : null)
            if (sid) discoveredId = sid
            if (ev.type === 'text') {
              const part = ev.part as Record<string, unknown> | undefined
              if (typeof part?.text === 'string') responseText += part.text
            } else if (ev.type === 'error') {
              const msg = typeof ev.error === 'string' ? ev.error : (typeof ev.message === 'string' ? ev.message : 'OpenCode error')
              stderrBuf += `${msg}\n`
            }
          } catch {
            responseText += `${line}\n`
          }
        }
      })

      child.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString()
        if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-16_000)
      })

      child.on('close', (code, signal) => {
        clearTimeout(timeoutHandle)
        if (discoveredId) bctx.persistDelegateResumeId?.('opencode', discoveredId)
        const output = responseText.trim()
        if (output) return finish(output)
        const stderr = stderrBuf.trim()
        if (stderr) return finish(`Error: ${stderr}`)
        return finish(`Error: OpenCode exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`)
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(`Error: ${err.message}`)
      })
    })
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function runGeminiDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext): Promise<string> {
  try {
    const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
    const storedResumeId = bctx.readStoredDelegateResumeId?.('gemini')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<string>((resolve) => {
      const args = ['--prompt', task, '--output-format', 'stream-json', '--yolo']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (text: string) => {
        if (settled) return
        settled = true
        resolve(truncate(text, MAX_OUTPUT))
      }

      const timeoutHandle = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }, bctx.claudeTimeoutMs || 300000)

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>
            // Capture session ID from init event
            if (ev.type === 'init' && typeof ev.session_id === 'string') {
              discoveredId = ev.session_id
            }
            // Capture assistant text from message events
            if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
              responseText += ev.content
            }
            // Capture final result
            if (ev.type === 'result' && ev.status === 'error') {
              const errMsg = typeof ev.error === 'string' ? ev.error : 'Gemini error'
              stderrBuf += `${errMsg}\n`
            }
          } catch {
            responseText += `${line}\n`
          }
        }
      })

      child.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString()
        if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-16_000)
      })

      child.on('close', (code, signal) => {
        clearTimeout(timeoutHandle)
        if (discoveredId) bctx.persistDelegateResumeId?.('gemini', discoveredId)
        const output = responseText.trim()
        if (output) return finish(output)
        const stderr = stderrBuf.trim()
        if (stderr) return finish(`Error: ${stderr}`)
        return finish(`Error: Gemini exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`)
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(`Error: ${err.message}`)
      })
    })
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function runClaudeDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext): Promise<string> {
  try {
    const env: NodeJS.ProcessEnv = stripEnvPrefixes({ ...process.env }, ['CLAUDE'])
    const authProbe = spawnSync(binary, ['auth', 'status'], { cwd: bctx.cwd, env, encoding: 'utf-8', timeout: 8000 })
    if ((authProbe.status ?? 1) !== 0) return 'Error: Claude Code not authenticated.'

    const storedResumeId = bctx.readStoredDelegateResumeId?.('claudeCode')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return new Promise<string>((resolve) => {
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)
      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      let assistantText = ''
      let discoveredId: string | null = null
      let settled = false
      
      const finish = (res: string) => { if (!settled) { settled = true; resolve(truncate(res, MAX_OUTPUT)) } }
      const timeoutHandle = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, bctx.claudeTimeoutMs || 300000)

      child.stdout?.on('data', (c) => {
        const lines = c.toString().split('\n')
        for (const l of lines) {
          const trimmed = l.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed) as Record<string, unknown>
            if (typeof ev.session_id === 'string') discoveredId = ev.session_id
            if (ev.type === 'result' && typeof ev.result === 'string') assistantText = ev.result
          } catch {
            assistantText += `${l}\n`
          }
        }
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
        if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
      })
      child.on('close', (code) => {
        clearTimeout(timeoutHandle)
        if (discoveredId) bctx.persistDelegateResumeId?.('claudeCode', discoveredId)
        const output = assistantText.trim()
        if (code === 0) finish(output || 'Task completed.')
        else finish(output ? output : `Error: Code ${code}. ${stderr.trim()}`)
      })
      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(`Error: ${err.message}`)
      })
      child.stdin?.write(task)
      child.stdin?.end()
    })
  } catch (err: unknown) { return `Error: ${err instanceof Error ? err.message : String(err)}` }
}

/**
 * Register as a Built-in Plugin
 */
const DelegatePlugin: Plugin = {
  name: 'Core Delegate',
  description: 'Delegate complex multi-file tasks to specialized CLI backends or other agents.',
  hooks: {
    getCapabilityDescription: () => 'I can hand off deep coding work to Claude Code, Codex, or Gemini CLI (`delegate`) for complex multi-file refactors and code generation. Resume IDs may come back via `[delegate_meta]`.',
    getOperatingGuidance: () => ['CRITICAL: `execute_command` (not delegation) for running servers, installs, scripts. Delegation sessions end and kill processes.', 'Delegate only for deep multi-file code work: refactors, debugging, generation, test suites.'],
  } as PluginHooks,
  tools: [
    {
      name: 'delegate',
      description: 'Delegate to a specialized backend (Claude, Codex, OpenCode, Gemini).',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          backend: { type: 'string', enum: ['claude', 'codex', 'opencode', 'gemini'] },
          resume: { type: 'boolean' },
          resumeId: { type: 'string', description: 'Optional explicit session/thread ID to resume' }
        },
        required: ['task']
      },
      execute: async (args, context) => executeDelegateAction(args, { ...context.session, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('delegate', DelegatePlugin)

/**
 * Legacy Bridge
 */
export function buildDelegateTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { hasPlugin } = bctx

  if (hasPlugin('delegate')) {
    tools.push(
      tool(
        async (args) => executeDelegateAction(args, bctx),
        {
          name: 'delegate',
          description: DelegatePlugin.tools![0].description,
          schema: z.object({}).passthrough()
        }
      )
    )
  }

  // Assign to agent and check status tools (kept as platform-level tools)
  if (bctx.ctx?.platformAssignScope === 'all' && bctx.ctx?.agentId) {
    // ... existing check_delegation_status and delegate_to_agent ...
    // These are already part of PLATFORM_TOOLS in tool-definitions
  }

  return tools
}
