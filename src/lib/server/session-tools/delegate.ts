import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import type { ToolBuildContext } from './context'
import { truncate, findBinaryOnPath, MAX_OUTPUT } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import {
  appendDelegationCheckpoint,
  cancelDelegationJob,
  completeDelegationJob,
  createDelegationJob,
  failDelegationJob,
  getDelegationJob,
  listDelegationJobs,
  recoverStaleDelegationJobs,
  registerDelegationRuntime,
  startDelegationJob,
} from '../delegation-jobs'
import { markProviderFailure, markProviderSuccess } from '../provider-health'

const MAX_DELEGATION_CHAIN_HOPS = 128
const DELEGATE_BACKEND_ORDER: DelegateBackend[] = ['claude', 'codex', 'opencode', 'gemini']

interface DelegateContext {
  id?: string
  sessionId?: string | null
  agentId?: string | null
  jobId?: string | null
  cwd?: string
  claudeTimeoutMs?: number
  readStoredDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini') => string | null
  persistDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini', id: string | null | undefined) => void
  ctx?: { platformAssignScope?: string; agentId?: string | null; sessionId?: string | null }
  hasPlugin?: (name: string) => boolean
  /** @deprecated Use hasPlugin */
  hasTool?: (name: string) => boolean
}

type DelegateBackend = 'claude' | 'codex' | 'opencode' | 'gemini'

interface DelegateRuntimeState {
  child?: ChildProcess | null
  cancel?: () => void
}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildDelegateContextFromSessionish(session: unknown): DelegateContext {
  const record = session && typeof session === 'object' ? session as Record<string, unknown> : {}
  const sessionId = typeof record.id === 'string'
    ? record.id
    : typeof record.sessionId === 'string'
      ? record.sessionId
      : null
  const agentId = typeof record.agentId === 'string' ? record.agentId : null
  const platformAssignScope = typeof record.platformAssignScope === 'string' ? record.platformAssignScope : undefined
  const storedResumeIds = record.delegateResumeIds && typeof record.delegateResumeIds === 'object'
    ? record.delegateResumeIds as Record<string, unknown>
    : null

  return {
    cwd: typeof record.cwd === 'string' ? record.cwd : process.cwd(),
    claudeTimeoutMs: typeof record.claudeTimeoutMs === 'number' ? record.claudeTimeoutMs : undefined,
    readStoredDelegateResumeId: typeof record.readStoredDelegateResumeId === 'function'
      ? record.readStoredDelegateResumeId as DelegateContext['readStoredDelegateResumeId']
      : (key) => {
          const raw = storedResumeIds?.[key]
          return typeof raw === 'string' && raw.trim() ? raw.trim() : null
        },
    persistDelegateResumeId: typeof record.persistDelegateResumeId === 'function'
      ? record.persistDelegateResumeId as DelegateContext['persistDelegateResumeId']
      : undefined,
    id: typeof record.id === 'string' ? record.id : undefined,
    sessionId,
    agentId,
    ctx: {
      sessionId,
      agentId,
      platformAssignScope,
    },
  }
}

function buildDelegateResumePatch(bctx: DelegateContext) {
  const resumeIds = {
    claudeCode: bctx.readStoredDelegateResumeId?.('claudeCode') || null,
    codex: bctx.readStoredDelegateResumeId?.('codex') || null,
    opencode: bctx.readStoredDelegateResumeId?.('opencode') || null,
    gemini: bctx.readStoredDelegateResumeId?.('gemini') || null,
  }
  const resumeId = resumeIds.claudeCode || resumeIds.codex || resumeIds.opencode || resumeIds.gemini || null
  return { resumeIds, resumeId }
}

function coerceDelegateBackend(value: unknown): DelegateBackend | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (['claude', 'claude code', 'claude-code', 'claude_code'].includes(normalized)) return 'claude'
  if (['codex', 'codex cli', 'codex-cli', 'codex_cli'].includes(normalized)) return 'codex'
  if (['opencode', 'open code', 'open-code', 'open_code'].includes(normalized)) return 'opencode'
  if (['gemini', 'gemini cli', 'gemini-cli', 'gemini_cli'].includes(normalized)) return 'gemini'
  return null
}

function buildDelegateTaskFromPayload(normalized: Record<string, unknown>): string | null {
  const action = String(normalized.action || '').trim().toLowerCase()
  const target = [
    normalized.target,
    normalized.path,
    normalized.filePath,
    normalized.filename,
    normalized.name,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined
  const content = typeof normalized.content === 'string' ? normalized.content.trim() : ''
  const taskName = typeof normalized.name === 'string' ? normalized.name.trim() : ''
  const files = Array.isArray(normalized.files) ? normalized.files : []
  const fileInstructions = files
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const filePath = typeof entry.path === 'string'
        ? entry.path.trim()
        : typeof entry.filePath === 'string'
          ? entry.filePath.trim()
          : typeof entry.filename === 'string'
            ? entry.filename.trim()
            : ''
      const fileContent = typeof entry.content === 'string' ? entry.content.trim() : ''
      if (!filePath && !fileContent) return ''
      if (filePath && fileContent) {
        return `Create or update "${filePath}" with this content:\n\n${fileContent}`
      }
      if (filePath) return `Create or update "${filePath}".`
      return `Create or update a file with this content:\n\n${fileContent}`
    })
    .filter(Boolean)

  if (['write', 'create', 'create_file', 'create-file', 'createfile'].includes(action)) {
    if (target && content) return `Create or overwrite the file "${target}" with this content:\n\n${content}`
    if (target) return `Create the file "${target}".`
  }
  if (['edit', 'update', 'modify'].includes(action)) {
    if (target && content) return `Update the file "${target}" with this content:\n\n${content}`
    if (target) return `Update the file "${target}".`
  }
  if (target && content) return `Perform the "${action || 'requested'}" task against "${target}" using this content:\n\n${content}`
  if (target) return `Perform the "${action || 'requested'}" task against "${target}".`
  if (fileInstructions.length > 0) {
    const intro = taskName || 'Perform the delegated file task.'
    return `${intro}\n\n${fileInstructions.join('\n\n')}`
  }
  if (content) return `Perform the delegated task with this content:\n\n${content}`
  if (taskName) return taskName
  return null
}

function normalizeDelegateArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolInputArgs(rawArgs)
  const backend = coerceDelegateBackend(
    normalized.backend
    ?? normalized.tool_name
    ?? normalized.toolName
    ?? normalized.delegate
    ?? normalized.provider,
  )
  if (backend && !normalized.backend) normalized.backend = backend
  if (typeof normalized.task !== 'string' && typeof normalized.prompt === 'string') normalized.task = normalized.prompt
  const action = String(normalized.action || '').trim().toLowerCase()
  const isLifecycleAction = ['status', 'list', 'wait', 'cancel'].includes(action)
  if (!isLifecycleAction) {
    if (typeof normalized.task !== 'string' || !normalized.task.trim()) {
      const synthesized = buildDelegateTaskFromPayload(normalized)
      if (synthesized) normalized.task = synthesized
    }
    normalized.action = 'start'
  }
  return normalized
}

function resolveDelegateSessionId(bctx: DelegateContext): string | null {
  const nested = typeof bctx.ctx?.sessionId === 'string' ? bctx.ctx.sessionId.trim() : ''
  if (nested) return nested
  const direct = typeof bctx.sessionId === 'string' ? bctx.sessionId.trim() : ''
  if (direct) return direct
  const legacy = typeof bctx.id === 'string' ? bctx.id.trim() : ''
  return legacy || null
}

function bindDelegateRuntime(runtime: DelegateRuntimeState | undefined, child: ChildProcess) {
  if (!runtime) return
  runtime.child = child
  runtime.cancel = () => {
    try {
      child.kill('SIGTERM')
    } catch {
      // best-effort cancel
    }
  }
  const clear = () => {
    if (runtime.child === child) runtime.child = null
  }
  child.once('close', clear)
  child.once('error', clear)
}

function coerceOptionalBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return null
}

function resumeStorageKeyForBackend(
  backend: 'claude' | 'codex' | 'opencode' | 'gemini',
): 'claudeCode' | 'codex' | 'opencode' | 'gemini' {
  if (backend === 'claude') return 'claudeCode'
  if (backend === 'codex') return 'codex'
  if (backend === 'opencode') return 'opencode'
  return 'gemini'
}

export function resolveDelegateResumeConfig(
  normalized: Record<string, unknown>,
  backend: 'claude' | 'codex' | 'opencode' | 'gemini',
  bctx: { readStoredDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini') => string | null },
): { resume: boolean; resumeId: string } {
  const explicitResumeId = typeof normalized.resumeId === 'string' ? normalized.resumeId.trim() : ''
  if (explicitResumeId) return { resume: true, resumeId: explicitResumeId }

  const explicitResume = coerceOptionalBool(normalized.resume)
  if (explicitResume !== null) return { resume: explicitResume, resumeId: '' }

  const storedResumeId = bctx.readStoredDelegateResumeId?.(resumeStorageKeyForBackend(backend))
  return {
    resume: Boolean(storedResumeId),
    resumeId: '',
  }
}

async function runDelegateBackend(args: Record<string, unknown>, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<string> {
  const normalized = normalizeDelegateArgs(args)
  const task = normalized.task as string
  const backend = ((normalized.backend as string) || 'claude') as DelegateBackend
  const { resume, resumeId } = resolveDelegateResumeConfig(normalized, backend, bctx)
  const backends = {
    claude: findBinaryOnPath('claude'),
    codex: findBinaryOnPath('codex'),
    opencode: findBinaryOnPath('opencode'),
    gemini: findBinaryOnPath('gemini'),
  }
  const binary = backends[backend as keyof typeof backends]
  if (!binary) return `Error: Backend "${backend}" unavailable.`

  if (backend === 'claude') return runClaudeDelegate(binary, task, resume, resumeId, bctx, runtime)
  if (backend === 'codex') return runCodexDelegate(binary, task, resume, resumeId, bctx, runtime)
  if (backend === 'opencode') return runOpenCodeDelegate(binary, task, resume, resumeId, bctx, runtime)
  if (backend === 'gemini') return runGeminiDelegate(binary, task, resume, resumeId, bctx, runtime)
  return `Error: Unsupported backend "${backend}".`
}

function providerIdForBackend(backend: DelegateBackend): string {
  if (backend === 'claude') return 'claude-cli'
  if (backend === 'codex') return 'codex-cli'
  if (backend === 'opencode') return 'opencode-cli'
  return 'gemini-cli'
}

function fallbackOrderForBackend(requested: DelegateBackend): DelegateBackend[] {
  return [requested, ...DELEGATE_BACKEND_ORDER.filter((backend) => backend !== requested)]
}

function isRecoverableDelegateFailure(result: string): boolean {
  const normalized = String(result || '').trim().toLowerCase()
  if (!normalized.startsWith('error:')) return false
  return [
    'not authenticated',
    'backend "',
    'unavailable',
    'enoent',
    'not found',
    'command not found',
    'spawn ',
    'eacces',
    'permission denied',
  ].some((needle) => normalized.includes(needle))
}

function summarizeDelegateAttempts(
  requested: DelegateBackend,
  attempts: Array<{ backend: DelegateBackend; result: string }>,
): string {
  const summary = attempts
    .map(({ backend, result }) => `${backend}: ${result.replace(/^Error:\s*/i, '').trim() || result.trim()}`)
    .join(' | ')
  return `Error: Delegate backend "${requested}" could not complete the task. ${summary}. Continue with another available tool instead of stopping.`
}

async function runDelegateBackendWithFallback(
  args: Record<string, unknown>,
  bctx: DelegateContext,
  runtime?: DelegateRuntimeState,
  opts?: { onAttempt?: (backend: DelegateBackend, attemptIndex: number) => void; onFallback?: (from: DelegateBackend, to: DelegateBackend, reason: string) => void },
): Promise<{ backend: DelegateBackend; result: string; attempts: Array<{ backend: DelegateBackend; result: string }> }> {
  const normalized = normalizeDelegateArgs(args)
  const requested = ((normalized.backend as string) || 'claude') as DelegateBackend
  const orderedBackends = fallbackOrderForBackend(requested)
  const attempts: Array<{ backend: DelegateBackend; result: string }> = []

  for (const [index, backend] of orderedBackends.entries()) {
    opts?.onAttempt?.(backend, index)
    const result = await runDelegateBackend({ ...normalized, backend }, bctx, runtime)
    attempts.push({ backend, result })
    if (/^Error:/i.test(result.trim())) {
      markProviderFailure(providerIdForBackend(backend), result)
    } else {
      markProviderSuccess(providerIdForBackend(backend))
      return { backend, result, attempts }
    }

    const nextBackend = orderedBackends[index + 1]
    if (nextBackend && isRecoverableDelegateFailure(result)) {
      opts?.onFallback?.(backend, nextBackend, result)
      continue
    }
    return {
      backend,
      result: attempts.length > 1 ? summarizeDelegateAttempts(requested, attempts) : result,
      attempts,
    }
  }

  return {
    backend: requested,
    result: summarizeDelegateAttempts(requested, attempts),
    attempts,
  }
}

async function waitForDelegateJob(jobId: string, timeoutSec = 30): Promise<string> {
  const timeoutAt = Date.now() + Math.max(1, timeoutSec) * 1000
  while (Date.now() < timeoutAt) {
    const job = getDelegationJob(jobId)
    if (!job) return `Error: delegation job "${jobId}" not found.`
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return JSON.stringify(job)
    }
    await sleep(1000)
  }
  const latest = getDelegationJob(jobId)
  return latest ? JSON.stringify(latest) : `Error: delegation job "${jobId}" not found.`
}

/**
 * Core Delegate Execution Logic
 */
async function executeDelegateAction(args: Record<string, unknown>, bctx: DelegateContext) {
  const normalized = normalizeDelegateArgs(args)
  const action = String(normalized.action || '').trim().toLowerCase()
  const task = normalized.task as string
  const requestedBackend = ((normalized.backend as string) || 'claude') as DelegateBackend
  const jobId = typeof normalized.jobId === 'string' ? normalized.jobId.trim() : ''
  const waitForCompletion = normalized.waitForCompletion !== false && normalized.background !== true
  const parentSessionId = resolveDelegateSessionId(bctx)

  recoverStaleDelegationJobs()

  if (action === 'status') {
    if (!jobId) return 'Error: jobId is required.'
    const job = getDelegationJob(jobId)
    return job ? JSON.stringify(job) : `Error: delegation job "${jobId}" not found.`
  }
  if (action === 'list') {
    const jobs = listDelegationJobs({ parentSessionId: parentSessionId || null })
      .filter((job) => job.kind === 'delegate')
    return JSON.stringify(jobs)
  }
  if (action === 'cancel') {
    if (!jobId) return 'Error: jobId is required.'
    const job = cancelDelegationJob(jobId)
    return job ? JSON.stringify(job) : `Error: delegation job "${jobId}" not found.`
  }
  if (action === 'wait') {
    if (!jobId) return 'Error: jobId is required.'
    const timeoutSec = typeof normalized.timeoutSec === 'number' ? normalized.timeoutSec : 30
    return waitForDelegateJob(jobId, timeoutSec)
  }

  if (!task) return 'Error: task is required.'

  const job = createDelegationJob({
    kind: 'delegate',
    parentSessionId,
    backend: requestedBackend,
    task,
    cwd: bctx.cwd || null,
  })
  appendDelegationCheckpoint(job.id, `Dispatching to ${requestedBackend}`, 'queued')
  startDelegationJob(job.id, { backend: requestedBackend, cwd: bctx.cwd || null })
  const runtimeHandle: DelegateRuntimeState = {}
  registerDelegationRuntime(job.id, runtimeHandle)

  const runner = runDelegateBackendWithFallback(args, bctx, runtimeHandle, {
    onAttempt: (backend, index) => {
      if (index === 0) return
      appendDelegationCheckpoint(job.id, `Retrying delegate with ${backend}`, 'running')
      startDelegationJob(job.id, { backend, cwd: bctx.cwd || null })
    },
    onFallback: (from, to, reason) => {
      appendDelegationCheckpoint(
        job.id,
        `Delegate ${from} failed: ${reason.replace(/^Error:\s*/i, '').trim()}. Falling back to ${to}.`,
        'running',
      )
    },
  })
    .then(({ backend, result }) => {
      const latest = getDelegationJob(job.id)
      if (latest?.status === 'cancelled') return { backend, result }
      const resumePatch = buildDelegateResumePatch(bctx)
      if (/^Error:/i.test(result.trim())) {
        appendDelegationCheckpoint(job.id, `Delegate failed on ${backend}`, 'failed')
        failDelegationJob(job.id, result.replace(/^Error:\s*/i, '').trim() || result, { ...resumePatch, backend })
      } else {
        appendDelegationCheckpoint(job.id, `Delegate completed on ${backend}`, 'completed')
        completeDelegationJob(job.id, result, { ...resumePatch, backend })
      }
      return { backend, result }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const latest = getDelegationJob(job.id)
      if (latest?.status === 'cancelled') return { backend: requestedBackend, result: `Error: ${message}` }
      appendDelegationCheckpoint(job.id, `Delegate crashed on ${requestedBackend}: ${message}`, 'failed')
      failDelegationJob(job.id, message, { ...buildDelegateResumePatch(bctx), backend: requestedBackend })
      return { backend: requestedBackend, result: `Error: ${message}` }
    })

  if (!waitForCompletion) {
    void runner
    return JSON.stringify({
      jobId: job.id,
      status: 'running',
      backend: requestedBackend,
    })
  }

  const { backend, result } = await runner
  const latest = getDelegationJob(job.id)
  return JSON.stringify({
    jobId: job.id,
    status: latest?.status || (/^Error:/i.test(result.trim()) ? 'failed' : 'completed'),
    backend: latest?.backend || backend,
    response: result,
  })
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

async function runCodexDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<string> {
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
      bindDelegateRuntime(runtime, child)
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

async function runOpenCodeDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<string> {
  try {
    const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
    const storedResumeId = bctx.readStoredDelegateResumeId?.('opencode')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<string>((resolve) => {
      const args = ['run', task, '--format', 'json']
      if (resumeIdToUse) args.push('--session', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
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

async function runGeminiDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<string> {
  try {
    const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
    const storedResumeId = bctx.readStoredDelegateResumeId?.('gemini')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<string>((resolve) => {
      const args = ['--prompt', task, '--output-format', 'stream-json', '--yolo']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
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

async function runClaudeDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<string> {
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
      bindDelegateRuntime(runtime, child)
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
      description: 'Delegate to a specialized backend (Claude, Codex, OpenCode, Gemini). Supports background jobs with action=status|list|wait|cancel.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'list', 'wait', 'cancel'] },
          task: { type: 'string' },
          backend: { type: 'string', enum: ['claude', 'codex', 'opencode', 'gemini'] },
          resume: { type: 'boolean' },
          resumeId: { type: 'string', description: 'Optional explicit session/thread ID to resume' },
          jobId: { type: 'string' },
          waitForCompletion: { type: 'boolean' },
          background: { type: 'boolean' },
          timeoutSec: { type: 'number' },
        },
        required: []
      },
      execute: async (args, context) => executeDelegateAction(args, buildDelegateContextFromSessionish(context.session))
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
