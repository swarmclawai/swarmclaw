import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { spawn, type ChildProcess } from 'child_process'
import type { ToolBuildContext } from './context'
import { truncate, findBinaryOnPath, MAX_OUTPUT } from './context'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { canonicalizeExtensionId } from '../tool-aliases'
import { errorMessage, sleep } from '@/lib/shared-utils'
import { buildCliEnv, probeCliAuth } from '@/lib/providers/cli-utils'
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
} from '@/lib/server/agents/delegation-jobs'
import { markProviderFailure, markProviderSuccess } from '../provider-health'
import { loadRuntimeSettings } from '../runtime/runtime-settings'
import { getSessionDepth } from '../agents/subagent-runtime'

const DELEGATE_BACKEND_ORDER: DelegateBackend[] = ['claude', 'codex', 'opencode', 'gemini', 'copilot', 'cursor', 'qwen']

interface DelegateContext {
  id?: string
  sessionId?: string | null
  agentId?: string | null
  jobId?: string | null
  cwd?: string
  claudeTimeoutMs?: number
  readStoredDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen') => string | null
  persistDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen', id: string | null | undefined) => void
  ctx?: {
    delegationEnabled?: boolean
    delegationTargetMode?: 'all' | 'selected'
    delegationTargetAgentIds?: string[]
    agentId?: string | null
    sessionId?: string | null
  }
  hasExtension?: (name: string) => boolean
  /** @deprecated Use hasExtension */
  hasTool?: (name: string) => boolean
}

type DelegateBackend = 'claude' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen'

interface DelegateRuntimeState {
  child?: ChildProcess | null
  cancel?: () => void
}

type DelegateFailureKind = 'auth' | 'unavailable' | 'spawn' | 'permission' | 'runtime' | 'timeout'

interface DelegateBackendResult {
  backend: DelegateBackend
  status: 'completed' | 'failed'
  response: string | null
  error: string | null
  failureKind?: DelegateFailureKind
}

interface DelegateBackendAdapter {
  backend: DelegateBackend
  binaryName: string
  run: (
    binary: string,
    task: string,
    resume: boolean,
    resumeId: string,
    bctx: DelegateContext,
    runtime?: DelegateRuntimeState,
  ) => Promise<DelegateBackendResult>
}

function buildDelegateContextFromSessionish(session: unknown): DelegateContext {
  const record = session && typeof session === 'object' ? session as Record<string, unknown> : {}
  const sessionId = typeof record.id === 'string'
    ? record.id
    : typeof record.sessionId === 'string'
      ? record.sessionId
      : null
  const agentId = typeof record.agentId === 'string' ? record.agentId : null
  const delegationEnabled = record.delegationEnabled === true
  const delegationTargetMode = record.delegationTargetMode === 'selected'
    ? 'selected'
    : 'all'
  const delegationTargetAgentIds = Array.isArray(record.delegationTargetAgentIds)
    ? record.delegationTargetAgentIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
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
      delegationEnabled,
      delegationTargetMode,
      delegationTargetAgentIds,
    },
  }
}

function buildDelegateResumePatch(bctx: DelegateContext) {
  const resumeIds = {
    claudeCode: bctx.readStoredDelegateResumeId?.('claudeCode') || null,
    codex: bctx.readStoredDelegateResumeId?.('codex') || null,
    opencode: bctx.readStoredDelegateResumeId?.('opencode') || null,
    gemini: bctx.readStoredDelegateResumeId?.('gemini') || null,
    copilot: bctx.readStoredDelegateResumeId?.('copilot') || null,
    cursor: bctx.readStoredDelegateResumeId?.('cursor') || null,
    qwen: bctx.readStoredDelegateResumeId?.('qwen') || null,
  }
  const resumeId = resumeIds.claudeCode || resumeIds.codex || resumeIds.opencode || resumeIds.gemini || resumeIds.copilot || resumeIds.cursor || resumeIds.qwen || null
  return { resumeIds, resumeId }
}

function coerceDelegateBackend(value: unknown): DelegateBackend | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (['claude', 'claude code', 'claude-code', 'claude_code'].includes(normalized)) return 'claude'
  if (['codex', 'codex cli', 'codex-cli', 'codex_cli'].includes(normalized)) return 'codex'
  if (['opencode', 'open code', 'open-code', 'open_code'].includes(normalized)) return 'opencode'
  if (['gemini', 'gemini cli', 'gemini-cli', 'gemini_cli'].includes(normalized)) return 'gemini'
  if (['copilot', 'copilot cli', 'copilot-cli', 'copilot_cli', 'github copilot'].includes(normalized)) return 'copilot'
  if (['cursor', 'cursor cli', 'cursor-cli', 'cursor_cli', 'cursor-agent'].includes(normalized)) return 'cursor'
  if (['qwen', 'qwen code', 'qwen-code', 'qwen_code', 'qwen-code-cli', 'qwen_code_cli'].includes(normalized)) return 'qwen'
  return null
}

function asDelegateRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function pickNonEmptyDelegateString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      continue
    }
    return trimmed
  }
  return null
}

function pickDelegateTaskText(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  return pickNonEmptyDelegateString(
    record.task,
    record.prompt,
    record.request,
    record.instructions,
    record.instruction,
    record.description,
    record.input,
    record.reason,
    record.goal,
    record.objective,
  )
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
  const nestedData = asDelegateRecord(normalized.data)
  const delegatePayload = {
    ...(nestedData || {}),
    ...normalized,
  }
  const backend = coerceDelegateBackend(
    delegatePayload.backend
    ?? delegatePayload.tool_name
    ?? delegatePayload.toolName
    ?? delegatePayload.tool
    ?? delegatePayload.delegate
    ?? delegatePayload.provider
    ?? delegatePayload.subagent_tool_id
    ?? delegatePayload.subagent_name,
  )
  if (backend && !normalized.backend) normalized.backend = backend
  if (typeof normalized.task !== 'string' || !normalized.task.trim()) {
    const directTask = pickDelegateTaskText(delegatePayload) || pickDelegateTaskText(nestedData)
    if (directTask) normalized.task = directTask
  }
  const lifecycleJobId = pickNonEmptyDelegateString(
    normalized.jobId,
    normalized.id,
    nestedData?.jobId,
    nestedData?.id,
  )
  if (lifecycleJobId && (!normalized.jobId || typeof normalized.jobId !== 'string')) {
    normalized.jobId = lifecycleJobId
  }
  const action = String(normalized.action ?? nestedData?.action ?? '').trim().toLowerCase()
  const isLifecycleAction = ['status', 'list', 'wait', 'cancel'].includes(action)
  if (action) normalized.action = action
  if (!isLifecycleAction) {
    if (typeof normalized.task !== 'string' || !normalized.task.trim()) {
      const synthesized = buildDelegateTaskFromPayload(delegatePayload)
      if (synthesized) normalized.task = synthesized
    }
    normalized.action = 'start'
  }
  return normalized
}

function resolveDirectLocalToolDelegationTarget(
  normalized: Record<string, unknown>,
  bctx: DelegateContext,
): string | null {
  const requestedTool = [
    normalized.tool,
    normalized.tool_name,
    normalized.toolName,
    normalized.tool_id,
    normalized.toolId,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined
  const trimmed = typeof requestedTool === 'string' ? requestedTool.trim() : ''
  if (!trimmed) return null
  if (coerceDelegateBackend(trimmed)) return null

  const canonical = canonicalizeExtensionId(trimmed) || trimmed.toLowerCase()
  if (canonical === 'delegate') return null
  const hasLocalTool = bctx.hasExtension?.(trimmed)
    || bctx.hasExtension?.(canonical)
    || bctx.hasTool?.(trimmed)
    || bctx.hasTool?.(canonical)
  return hasLocalTool ? canonical : null
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
  backend: 'claude' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen',
): 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen' {
  if (backend === 'claude') return 'claudeCode'
  if (backend === 'codex') return 'codex'
  if (backend === 'opencode') return 'opencode'
  if (backend === 'gemini') return 'gemini'
  if (backend === 'copilot') return 'copilot'
  if (backend === 'cursor') return 'cursor'
  return 'qwen'
}

export function resolveDelegateResumeConfig(
  normalized: Record<string, unknown>,
  backend: 'claude' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen',
  bctx: { readStoredDelegateResumeId?: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen') => string | null },
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

function buildDelegateFailure(
  backend: DelegateBackend,
  error: string,
  failureKind: DelegateFailureKind = 'runtime',
): DelegateBackendResult {
  return {
    backend,
    status: 'failed',
    response: null,
    error: error.trim() || `Delegate backend "${backend}" failed.`,
    failureKind,
  }
}

function buildDelegateSuccess(
  backend: DelegateBackend,
  response: string,
): DelegateBackendResult {
  return {
    backend,
    status: 'completed',
    response: truncate(response, MAX_OUTPUT),
    error: null,
  }
}

function formatDelegateResultText(result: DelegateBackendResult): string {
  if (result.status === 'completed') {
    return truncate(result.response?.trim() || 'Task completed.', MAX_OUTPUT)
  }
  const error = result.error?.trim() || `Delegate backend "${result.backend}" failed.`
  return truncate(`Error: ${error}`, MAX_OUTPUT)
}

const DELEGATE_BACKEND_ADAPTERS: Record<DelegateBackend, DelegateBackendAdapter> = {
  claude: {
    backend: 'claude',
    binaryName: 'claude',
    run: runClaudeDelegate,
  },
  codex: {
    backend: 'codex',
    binaryName: 'codex',
    run: runCodexDelegate,
  },
  opencode: {
    backend: 'opencode',
    binaryName: 'opencode',
    run: runOpenCodeDelegate,
  },
  gemini: {
    backend: 'gemini',
    binaryName: 'gemini',
    run: runGeminiDelegate,
  },
  copilot: {
    backend: 'copilot',
    binaryName: 'copilot',
    run: runCopilotDelegate,
  },
  cursor: {
    backend: 'cursor',
    binaryName: 'cursor-agent',
    run: runCursorDelegate,
  },
  qwen: {
    backend: 'qwen',
    binaryName: 'qwen',
    run: runQwenDelegate,
  },
}

async function runDelegateBackend(args: Record<string, unknown>, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  const normalized = normalizeDelegateArgs(args)
  const task = normalized.task as string
  const backend = ((normalized.backend as string) || 'claude') as DelegateBackend
  const { resume, resumeId } = resolveDelegateResumeConfig(normalized, backend, bctx)
  const adapter = DELEGATE_BACKEND_ADAPTERS[backend]
  if (!adapter) return buildDelegateFailure(backend, `Unsupported backend "${backend}".`, 'unavailable')
  const binary = findBinaryOnPath(adapter.binaryName)
  if (!binary) return buildDelegateFailure(backend, `Backend "${backend}" unavailable.`, 'unavailable')
  return adapter.run(binary, task, resume, resumeId, bctx, runtime)
}

function providerIdForBackend(backend: DelegateBackend): string {
  if (backend === 'claude') return 'claude-cli'
  if (backend === 'codex') return 'codex-cli'
  if (backend === 'opencode') return 'opencode-cli'
  if (backend === 'gemini') return 'gemini-cli'
  if (backend === 'copilot') return 'copilot-cli'
  if (backend === 'cursor') return 'cursor-cli'
  return 'qwen-code-cli'
}

function fallbackOrderForBackend(requested: DelegateBackend): DelegateBackend[] {
  return [requested, ...DELEGATE_BACKEND_ORDER.filter((backend) => backend !== requested)]
}

function isRecoverableDelegateFailure(result: DelegateBackendResult): boolean {
  if (result.status !== 'failed') return false
  if (result.failureKind === 'auth' || result.failureKind === 'unavailable' || result.failureKind === 'spawn' || result.failureKind === 'permission') {
    return true
  }
  const normalized = String(result.error || '').trim().toLowerCase()
  return [
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
  attempts: Array<{ backend: DelegateBackend; result: DelegateBackendResult }>,
): DelegateBackendResult {
  const summary = attempts
    .map(({ backend, result }) => `${backend}: ${result.error?.trim() || formatDelegateResultText(result).replace(/^Error:\s*/i, '').trim()}`)
    .join(' | ')
  return buildDelegateFailure(
    requested,
    `Delegate backend "${requested}" could not complete the task. ${summary}. Continue with another available tool instead of stopping.`,
    'runtime',
  )
}

async function runDelegateBackendWithFallback(
  args: Record<string, unknown>,
  bctx: DelegateContext,
  runtime?: DelegateRuntimeState,
  opts?: { onAttempt?: (backend: DelegateBackend, attemptIndex: number) => void; onFallback?: (from: DelegateBackend, to: DelegateBackend, reason: string) => void },
): Promise<{ backend: DelegateBackend; result: DelegateBackendResult; attempts: Array<{ backend: DelegateBackend; result: DelegateBackendResult }> }> {
  const normalized = normalizeDelegateArgs(args)
  const requested = ((normalized.backend as string) || 'claude') as DelegateBackend
  const orderedBackends = fallbackOrderForBackend(requested)
  const attempts: Array<{ backend: DelegateBackend; result: DelegateBackendResult }> = []

  for (const [index, backend] of orderedBackends.entries()) {
    opts?.onAttempt?.(backend, index)
    const result = await runDelegateBackend({ ...normalized, backend }, bctx, runtime)
    attempts.push({ backend, result })
    if (result.status === 'completed') {
      markProviderSuccess(providerIdForBackend(backend))
      return { backend, result, attempts }
    }
    markProviderFailure(providerIdForBackend(backend), formatDelegateResultText(result))

    const nextBackend = orderedBackends[index + 1]
    if (nextBackend && isRecoverableDelegateFailure(result)) {
      opts?.onFallback?.(backend, nextBackend, result.error || formatDelegateResultText(result))
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
  const directLocalToolTarget = resolveDirectLocalToolDelegationTarget(normalized, bctx)
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

  if (directLocalToolTarget) {
    return `Error: \`${directLocalToolTarget}\` is already available in this session. Call \`${directLocalToolTarget}\` directly instead of wrapping it inside \`delegate\`.`
  }

  if (!task) return 'Error: task is required.'

  // Enforce delegation depth limit (matches subagent depth guard)
  const runtime = loadRuntimeSettings()
  const maxDepth = runtime.delegationMaxDepth || 3
  const currentDepth = parentSessionId ? getSessionDepth(parentSessionId, maxDepth) : 0
  if (currentDepth >= maxDepth) {
    return `Error: Maximum delegation depth (${maxDepth}) reached. Complete the task directly instead of delegating further.`
  }

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
        `Delegate ${from} failed: ${reason.trim()}. Falling back to ${to}.`,
        'running',
      )
    },
  })
    .then(({ backend, result }) => {
      const latest = getDelegationJob(job.id)
      if (latest?.status === 'cancelled') return { backend, result }
      const resumePatch = buildDelegateResumePatch(bctx)
      if (result.status === 'failed') {
        appendDelegationCheckpoint(job.id, `Delegate failed on ${backend}`, 'failed')
        failDelegationJob(job.id, result.error || `Delegate backend "${backend}" failed.`, { ...resumePatch, backend })
      } else {
        appendDelegationCheckpoint(job.id, `Delegate completed on ${backend}`, 'completed')
        completeDelegationJob(job.id, result.response || 'Task completed.', { ...resumePatch, backend })
      }
      return { backend, result }
    })
    .catch((err: unknown) => {
      const message = errorMessage(err)
      const latest = getDelegationJob(job.id)
      if (latest?.status === 'cancelled') return { backend: requestedBackend, result: buildDelegateFailure(requestedBackend, message) }
      appendDelegationCheckpoint(job.id, `Delegate crashed on ${requestedBackend}: ${message}`, 'failed')
      failDelegationJob(job.id, message, { ...buildDelegateResumePatch(bctx), backend: requestedBackend })
      return { backend: requestedBackend, result: buildDelegateFailure(requestedBackend, message, 'runtime') }
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
    status: latest?.status || result.status,
    backend: latest?.backend || backend,
    response: formatDelegateResultText(result),
  })
}

// stripEnvPrefixes removed — use buildCliEnv() from cli-utils instead

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

function parseCursorOutputText(ev: Record<string, unknown>): string | null {
  if (typeof ev.result === 'string' && ev.result.trim()) return ev.result
  if (typeof ev.text === 'string' && ev.text.trim()) return ev.text
  if (typeof ev.message === 'string' && ev.message.trim()) return ev.message
  const message = ev.message
  if (message && typeof message === 'object') {
    const record = message as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim()) return record.text
    if (typeof record.content === 'string' && record.content.trim()) return record.content
  }
  if (ev.type === 'delta') {
    const delta = ev.delta as Record<string, unknown> | undefined
    if (typeof delta?.text === 'string' && delta.text.trim()) return delta.text
  }
  return null
}

function parseQwenOutputText(ev: Record<string, unknown>): string | null {
  if (typeof ev.result === 'string' && ev.result.trim()) return ev.result
  if (ev.type === 'content_block_delta') {
    const delta = ev.delta as Record<string, unknown> | undefined
    if (typeof delta?.text === 'string' && delta.text.trim()) return delta.text
  }
  if (ev.type === 'assistant') {
    const message = ev.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => typeof entry.text === 'string' ? entry.text : '')
      .join('')
      .trim()
    if (text) return text
  }
  return null
}

async function runCodexDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    // Build clean env — preserves user's CODEX_HOME for auth
    const env = buildCliEnv()

    // Auth probe BEFORE any temp CODEX_HOME override
    const auth = probeCliAuth(binary, 'codex', env, bctx.cwd)
    if (!auth.authenticated) {
      return buildDelegateFailure('codex', auth.errorMessage || 'Codex CLI is not authenticated. Run `codex login` and retry.', 'auth')
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('codex')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<DelegateBackendResult>((resolve) => {
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

      const finish = (result: DelegateBackendResult) => {
        if (settled) return
        settled = true
        resolve(result)
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
        if (output) return finish(buildDelegateSuccess('codex', output))
        const stderr = stderrBuf.trim()
        if (stderr) return finish(buildDelegateFailure('codex', stderr))
        return finish(buildDelegateFailure('codex', `Codex exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, 'runtime'))
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('codex', err.message, 'spawn'))
      })

      child.stdin?.write(task)
      child.stdin?.end()
    })
  } catch (err: unknown) {
    return buildDelegateFailure('codex', errorMessage(err), 'runtime')
  }
}

async function runOpenCodeDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    const env = buildCliEnv()

    // Auth probe
    const auth = probeCliAuth(binary, 'opencode', env, bctx.cwd)
    if (!auth.authenticated) {
      return buildDelegateFailure('opencode', auth.errorMessage || 'OpenCode CLI is not authenticated.', 'auth')
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('opencode')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<DelegateBackendResult>((resolve) => {
      const args = ['run', task, '--format', 'json']
      if (resumeIdToUse) args.push('--session', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (result: DelegateBackendResult) => {
        if (settled) return
        settled = true
        resolve(result)
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
        if (output) return finish(buildDelegateSuccess('opencode', output))
        const stderr = stderrBuf.trim()
        if (stderr) return finish(buildDelegateFailure('opencode', stderr))
        return finish(buildDelegateFailure('opencode', `OpenCode exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, 'runtime'))
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('opencode', err.message, 'spawn'))
      })
    })
  } catch (err: unknown) {
    return buildDelegateFailure('opencode', errorMessage(err), 'runtime')
  }
}

async function runGeminiDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    const env = buildCliEnv()

    // Auth probe
    const auth = probeCliAuth(binary, 'gemini', env, bctx.cwd)
    if (!auth.authenticated) {
      return buildDelegateFailure('gemini', auth.errorMessage || 'Gemini CLI is not authenticated.', 'auth')
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('gemini')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<DelegateBackendResult>((resolve) => {
      const args = ['--prompt', task, '--output-format', 'stream-json', '--yolo']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (result: DelegateBackendResult) => {
        if (settled) return
        settled = true
        resolve(result)
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
        if (output) return finish(buildDelegateSuccess('gemini', output))
        const stderr = stderrBuf.trim()
        if (stderr) return finish(buildDelegateFailure('gemini', stderr))
        return finish(buildDelegateFailure('gemini', `Gemini exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, 'runtime'))
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('gemini', err.message, 'spawn'))
      })
    })
  } catch (err: unknown) {
    return buildDelegateFailure('gemini', errorMessage(err), 'runtime')
  }
}

async function runCopilotDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    const env = buildCliEnv()
    const auth = probeCliAuth(binary, 'copilot', env, bctx.cwd)
    if (!auth.authenticated) {
      return buildDelegateFailure('copilot', auth.errorMessage || 'Copilot CLI is not authenticated.', 'auth')
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('copilot')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<DelegateBackendResult>((resolve) => {
      const args = ['-p', task, '--output-format=json', '-s', '--yolo']
      if (resumeIdToUse) args.push(`--resume=${resumeIdToUse}`)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (result: DelegateBackendResult) => {
        if (settled) return
        settled = true
        resolve(result)
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
            const sid = typeof ev.session_id === 'string'
              ? ev.session_id
              : typeof ev.sessionId === 'string'
                ? ev.sessionId
                : null
            if (sid) discoveredId = sid
            const text = parseCursorOutputText(ev)
            if (text) {
              if (String(ev.type || '').includes('result') || String(ev.type || '').includes('completed')) responseText = text
              else responseText += text
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
        if (discoveredId) bctx.persistDelegateResumeId?.('copilot', discoveredId)
        const output = responseText.trim()
        if (output) return finish(buildDelegateSuccess('copilot', output))
        const stderr = stderrBuf.trim()
        if (stderr) return finish(buildDelegateFailure('copilot', stderr))
        return finish(buildDelegateFailure('copilot', `Copilot exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, 'runtime'))
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('copilot', err.message, 'spawn'))
      })
    })
  } catch (err: unknown) {
    return buildDelegateFailure('copilot', errorMessage(err), 'runtime')
  }
}

async function runCursorDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    const env = buildCliEnv()
    const auth = probeCliAuth(binary, 'cursor', env, bctx.cwd)
    if (!auth.authenticated) {
      return buildDelegateFailure('cursor', auth.errorMessage || 'Cursor Agent CLI is not authenticated.', 'auth')
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('cursor')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<DelegateBackendResult>((resolve) => {
      const args = ['--print', '--output-format', 'stream-json']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)
      args.push(task)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (result: DelegateBackendResult) => {
        if (settled) return
        settled = true
        resolve(result)
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
            const sid = typeof ev.session_id === 'string'
              ? ev.session_id
              : typeof ev.sessionId === 'string'
                ? ev.sessionId
                : typeof ev.thread_id === 'string'
                  ? ev.thread_id
                  : null
            if (sid) discoveredId = sid
            const text = parseCursorOutputText(ev)
            if (text) {
              if (String(ev.type || '').includes('result') || String(ev.type || '').includes('completed')) responseText = text
              else responseText += text
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
        if (discoveredId) bctx.persistDelegateResumeId?.('cursor', discoveredId)
        const output = responseText.trim()
        if (output) return finish(buildDelegateSuccess('cursor', output))
        const stderr = stderrBuf.trim()
        if (stderr) return finish(buildDelegateFailure('cursor', stderr))
        return finish(buildDelegateFailure('cursor', `Cursor exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, 'runtime'))
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('cursor', err.message, 'spawn'))
      })
    })
  } catch (err: unknown) {
    return buildDelegateFailure('cursor', errorMessage(err), 'runtime')
  }
}

async function runQwenDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    const env = buildCliEnv()
    const auth = probeCliAuth(binary, 'qwen', env, bctx.cwd)
    if (!auth.authenticated) {
      return buildDelegateFailure('qwen', auth.errorMessage || 'Qwen Code CLI is not configured.', 'auth')
    }

    const storedResumeId = bctx.readStoredDelegateResumeId?.('qwen')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return await new Promise<DelegateBackendResult>((resolve) => {
      const args = ['-p', task, '--output-format', 'stream-json', '--include-partial-messages', '--yolo']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)

      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
      let stdoutBuf = ''
      let stderrBuf = ''
      let responseText = ''
      let discoveredId: string | null = null
      let settled = false

      const finish = (result: DelegateBackendResult) => {
        if (settled) return
        settled = true
        resolve(result)
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
            const sid = typeof ev.session_id === 'string'
              ? ev.session_id
              : typeof ev.sessionId === 'string'
                ? ev.sessionId
                : null
            if (sid) discoveredId = sid
            const text = parseQwenOutputText(ev)
            if (text) {
              if (ev.type === 'assistant' || ev.type === 'result') responseText = text
              else responseText += text
            } else if (ev.type === 'result' && ev.subtype === 'error') {
              stderrBuf += `${typeof ev.result === 'string' ? ev.result : 'Qwen Code error'}\n`
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
        if (discoveredId) bctx.persistDelegateResumeId?.('qwen', discoveredId)
        const output = responseText.trim()
        if (output) return finish(buildDelegateSuccess('qwen', output))
        const stderr = stderrBuf.trim()
        if (stderr) return finish(buildDelegateFailure('qwen', stderr))
        return finish(buildDelegateFailure('qwen', `Qwen Code exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`, 'runtime'))
      })

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('qwen', err.message, 'spawn'))
      })
    })
  } catch (err: unknown) {
    return buildDelegateFailure('qwen', errorMessage(err), 'runtime')
  }
}

async function runClaudeDelegate(binary: string, task: string, resume: boolean, resumeId: string, bctx: DelegateContext, runtime?: DelegateRuntimeState): Promise<DelegateBackendResult> {
  try {
    const env = buildCliEnv()
    const auth = probeCliAuth(binary, 'claude', env, bctx.cwd)
    if (!auth.authenticated) return buildDelegateFailure('claude', auth.errorMessage || 'Claude Code not authenticated.', 'auth')

    const storedResumeId = bctx.readStoredDelegateResumeId?.('claudeCode')
    const resumeIdToUse = resumeId?.trim() || (resume ? storedResumeId : null)

    return new Promise<DelegateBackendResult>((resolve) => {
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
      if (resumeIdToUse) args.push('--resume', resumeIdToUse)
      const child = spawn(binary, args, { cwd: bctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      bindDelegateRuntime(runtime, child)
      let stderr = ''
      let assistantText = ''
      let discoveredId: string | null = null
      let settled = false
      
      const finish = (result: DelegateBackendResult) => { if (!settled) { settled = true; resolve(result) } }
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
        if (code === 0) finish(buildDelegateSuccess('claude', output || 'Task completed.'))
        else finish(buildDelegateFailure('claude', output || `Code ${code}. ${stderr.trim()}`))
      })
      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        finish(buildDelegateFailure('claude', err.message, 'spawn'))
      })
      child.stdin?.write(task)
      child.stdin?.end()
    })
  } catch (err: unknown) { return buildDelegateFailure('claude', errorMessage(err), 'runtime') }
}

/**
 * Register as a Built-in Extension
 */
const DelegateExtension: Extension = {
  name: 'Core Delegate',
  description: 'Delegate complex multi-file tasks to specialized CLI backends or other agents.',
  hooks: {
    getCapabilityDescription: () => 'I can hand off coding work to Claude Code, Codex, OpenCode, Gemini CLI, Cursor CLI, or Qwen Code CLI (`delegate`) for file creation, refactoring, debugging, code generation, and multi-file edits. Resume IDs may come back via `[delegate_meta]`.',
    getOperatingGuidance: () => ['CRITICAL: `execute_command` (not delegation) for running servers, installs, scripts. Delegation sessions end and kill processes.', 'Delegate for code tasks: writing/creating files, refactors, debugging, generation, test suites, data exports to files.'],
  } as ExtensionHooks,
  tools: [
    {
      name: 'delegate',
      description: 'Delegate to a specialized backend (Claude, Codex, OpenCode, Gemini, Cursor, Qwen) for code tasks: writing files, refactoring, debugging, code generation, and multi-file edits. Supports background jobs with action=status|list|wait|cancel.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'list', 'wait', 'cancel'] },
          task: { type: 'string' },
          backend: { type: 'string', enum: ['claude', 'codex', 'opencode', 'gemini', 'copilot', 'cursor', 'qwen'] },
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

registerNativeCapability('delegate', DelegateExtension)

/**
 * Legacy Bridge
 */
export function buildDelegateTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { hasExtension } = bctx

  if (bctx.ctx?.delegationEnabled && hasExtension('delegate')) {
    tools.push(
      tool(
        async (args) => executeDelegateAction(args, bctx),
        {
          name: 'delegate',
          description: DelegateExtension.tools![0].description,
          schema: z.object({}).passthrough()
        }
      )
    )
  }

  // Assign to agent and check status tools (kept as platform-level tools)
  if (bctx.ctx?.delegationEnabled && bctx.ctx?.agentId) {
    // ... existing check_delegation_status and delegate_to_agent ...
    // These are already part of PLATFORM_TOOLS in tool-definitions
  }

  return tools
}
