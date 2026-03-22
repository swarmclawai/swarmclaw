import { genId } from '@/lib/id'
import type { SessionRunRecord } from '@/types'
import { getSession } from '@/lib/server/sessions/session-repository'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { log } from '@/lib/server/logger'
import { isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'
import { getEnabledToolIds } from '@/lib/capability-selection'
import { isAllEstopEngaged, isAutonomyEstopEngaged } from '@/lib/server/runtime/estop'
import { isRestartRecoverableSource } from '@/lib/server/runtime/run-ledger'
import { getActiveSessionProcess } from '@/lib/server/runtime/runtime-state'

import { cancelPendingForSession } from './cancellation'
import {
  abortSessionRuntime,
  chainCallerSignal,
  COLLECT_COALESCE_WINDOW_MS,
  emitRunMeta,
  executionKeyForSession,
  incrementNonHeartbeatWork,
  messagePreview,
  nextQueuedAt,
  normalizeMode,
  queueForExecution,
  reconcileSessionActivityLease,
  registerRun,
  state,
  syncRunRecord,
} from './state'
import type {
  EnqueueSessionRunInput,
  EnqueueSessionRunResult,
  SessionQueueMode,
  SessionRunQueueEntry,
} from './types'

type RepairSessionRunQueueFn = (
  sessionId: string,
  opts?: {
    executionKey?: string
    maxQueuedAgeMs?: number
    reason?: string
  },
) => { kickedExecutionKeys: number; recoveredQueuedRuns: number }

type DrainExecutionFn = (executionKey: string) => Promise<void>

const LONG_TOOL_NAMES: ReadonlySet<string> = new Set(['claude_code', 'codex_cli', 'opencode_cli'])

type SessionToolConfig = {
  tools?: string[] | null
  extensions?: string[] | null
}

function computeEffectiveRunTimeoutMs(
  baseTimeoutMs: number,
  sessionTools: string[],
  runtime: { claudeCodeTimeoutMs: number },
): number {
  const hasLongTool = sessionTools.some((tool) => LONG_TOOL_NAMES.has(tool))
  if (!hasLongTool) return baseTimeoutMs
  const toolTimeout = runtime.claudeCodeTimeoutMs + 120_000
  return Math.max(baseTimeoutMs, toolTimeout)
}

function isAutonomyManagedEnqueue(source: string, internal: boolean): boolean {
  return !(source === 'chat' && !internal)
}

function buildRecoveryPayload(
  input: EnqueueSessionRunInput,
  source: string,
  mode: SessionQueueMode,
  maxRuntimeMs: number | undefined,
  executionKey: string,
) {
  return {
    message: input.message,
    imagePath: input.imagePath,
    imageUrl: input.imageUrl,
    attachedFiles: input.attachedFiles,
    internal: input.internal === true,
    source,
    mode,
    maxRuntimeMs,
    modelOverride: input.modelOverride,
    heartbeatConfig: input.heartbeatConfig,
    replyToId: input.replyToId,
    executionGroupKey: executionKey.startsWith('session:') ? undefined : executionKey,
  }
}

function findDedupeMatch(sessionId: string, dedupeKey?: string) {
  if (!dedupeKey) return null
  const executionKey = executionKeyForSession(sessionId)
  const running = state.runningByExecution.get(executionKey)
  if (running?.run.sessionId === sessionId && running.run.dedupeKey === dedupeKey) return running
  const queue = queueForExecution(executionKey)
  return queue.find((entry) => entry.run.sessionId === sessionId && entry.run.dedupeKey === dedupeKey) || null
}

export function enqueueSessionRun(
  input: EnqueueSessionRunInput,
  deps: {
    repairSessionRunQueue: RepairSessionRunQueueFn
    drainExecution: DrainExecutionFn
  },
): EnqueueSessionRunResult {
  const internal = input.internal === true
  const mode = normalizeMode(input.mode, internal)
  const source = input.source || 'chat'
  if (isAllEstopEngaged()) {
    throw new Error('Execution is blocked because all estop is engaged.')
  }
  if (isAutonomyEstopEngaged() && isAutonomyManagedEnqueue(source, internal)) {
    throw new Error(`Autonomy estop is engaged. New ${source} runs are paused.`)
  }
  const executionKey = typeof input.executionGroupKey === 'string' && input.executionGroupKey.trim()
    ? input.executionGroupKey.trim()
    : executionKeyForSession(input.sessionId)
  deps.repairSessionRunQueue(input.sessionId, {
    executionKey,
    reason: 'Recovered stale queued run before enqueue',
  })
  const runtime = loadRuntimeSettings()
  const defaultMaxRuntimeMs = runtime.ongoingLoopMaxRuntimeMs ?? (10 * 60_000)
  const sessionData = getSession(input.sessionId) as SessionToolConfig | null
  const sessionTools = getEnabledToolIds(sessionData)
  const adjustedDefaultMs = computeEffectiveRunTimeoutMs(defaultMaxRuntimeMs, sessionTools, runtime)
  const effectiveMaxRuntimeMs = typeof input.maxRuntimeMs === 'number'
    ? input.maxRuntimeMs
    : adjustedDefaultMs

  const dedupe = findDedupeMatch(input.sessionId, input.dedupeKey)
  if (dedupe) {
    const cb = input.onEvent
    if (cb) dedupe.onEvents.push(cb)
    if (input.callerSignal) chainCallerSignal(input.callerSignal, dedupe.signalController)
    return {
      runId: dedupe.run.id,
      position: 0,
      deduped: true,
      promise: dedupe.promise,
      abort: () => dedupe.signalController.abort(),
      unsubscribe: () => {
        if (!cb) return
        const idx = dedupe.onEvents.indexOf(cb)
        if (idx >= 0) dedupe.onEvents.splice(idx, 1)
      },
    }
  }

  if (mode === 'steer') {
    const running = state.runningByExecution.get(executionKey)
    if (running && running.run.sessionId === input.sessionId) {
      running.signalController.abort()
      try { getActiveSessionProcess(input.sessionId)?.kill?.() } catch { /* noop */ }
    }
    cancelPendingForSession(input.sessionId, 'Cancelled by steer mode')
  }

  if (!internal && source === 'chat') {
    const running = state.runningByExecution.get(executionKey)
    if (running && isInternalHeartbeatRun(running.run.internal, running.run.source)) {
      log.info('session-run', `Preempting heartbeat ${running.run.id} for user chat on ${input.sessionId}`)
      abortSessionRuntime(running, 'Preempted by user chat')
      state.runningByExecution.delete(executionKey)
    }
  }

  const running = state.runningByExecution.get(executionKey)
  const queue = queueForExecution(executionKey)
  if (mode === 'collect' && !input.imagePath && !input.imageUrl && !input.attachedFiles?.length) {
    const nowMs = nextQueuedAt()
    const candidate = queue.at(-1)
    const canCoalesce = !!candidate
      && candidate.run.mode === 'collect'
      && candidate.run.internal === internal
      && candidate.run.source === source
      && !candidate.imagePath
      && !candidate.imageUrl
      && !candidate.attachedFiles?.length
      && (nowMs - candidate.run.queuedAt) <= COLLECT_COALESCE_WINDOW_MS

    if (candidate && canCoalesce) {
      const nextChunk = input.message.trim()
      if (nextChunk) {
        const current = candidate.message.trim()
        candidate.message = current
          ? `${current}\n\n[Collected follow-up]\n${nextChunk}`
          : nextChunk
        candidate.run.messagePreview = messagePreview(candidate.message)
        candidate.run.queuedAt = nowMs
        syncRunRecord(candidate.run)
      }
      const coalesceCb = input.onEvent
      if (coalesceCb) candidate.onEvents.push(coalesceCb)
      if (input.callerSignal) chainCallerSignal(input.callerSignal, candidate.signalController)
      emitRunMeta(candidate, 'queued', { position: 0, coalesced: true, mergedIntoRunId: candidate.run.id })
      return {
        runId: candidate.run.id,
        position: 0,
        coalesced: true,
        promise: candidate.promise,
        abort: () => candidate.signalController.abort(),
        unsubscribe: () => {
          if (!coalesceCb) return
          const idx = candidate.onEvents.indexOf(coalesceCb)
          if (idx >= 0) candidate.onEvents.splice(idx, 1)
        },
      }
    }
  }

  const runId = genId(8)
  const run: SessionRunRecord = {
    id: runId,
    sessionId: input.sessionId,
    missionId: input.missionId ?? getSession(input.sessionId)?.missionId ?? null,
    kind: 'session_turn',
    ownerType: 'session',
    ownerId: input.sessionId,
    parentExecutionId: null,
    recoveryPolicy: isRestartRecoverableSource(source) ? 'restart_recoverable' : 'ephemeral',
    source,
    internal,
    mode,
    status: 'queued',
    messagePreview: messagePreview(input.message),
    dedupeKey: input.dedupeKey,
    queuedAt: nextQueuedAt(),
    recoveredFromRestart: input.recoveredFromRestart === true,
    recoveredFromRunId: input.recoveredFromRunId,
    recoveryPayload: buildRecoveryPayload(
      input,
      source,
      mode,
      effectiveMaxRuntimeMs > 0 ? effectiveMaxRuntimeMs : undefined,
      executionKey,
    ),
  }
  registerRun(run)

  let resolve!: EnqueueSessionRunResult['promise'] extends Promise<infer T> ? (value: T) => void : never
  let reject!: (error: Error) => void
  const promise = new Promise<import('@/lib/server/chat-execution/chat-execution-types').ExecuteChatTurnResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  state.promises.set(runId, promise)

  const entry: SessionRunQueueEntry = {
    executionKey,
    run,
    message: input.message,
    imagePath: input.imagePath,
    imageUrl: input.imageUrl,
    attachedFiles: input.attachedFiles,
    onEvents: input.onEvent ? [input.onEvent] : [],
    signalController: new AbortController(),
    maxRuntimeMs: effectiveMaxRuntimeMs > 0 ? effectiveMaxRuntimeMs : undefined,
    modelOverride: input.modelOverride,
    heartbeatConfig: input.heartbeatConfig,
    replyToId: input.replyToId,
    resolve,
    reject,
    promise,
  }

  if (input.callerSignal) chainCallerSignal(input.callerSignal, entry.signalController)

  queue.push(entry)
  incrementNonHeartbeatWork(entry)
  if (entry.nonHeartbeatCounted) {
    reconcileSessionActivityLease(input.sessionId)
  }
  const position = (running ? 1 : 0) + queue.length - 1
  emitRunMeta(entry, 'queued', { position })
  void deps.drainExecution(executionKey)

  const entryCb = input.onEvent
  return {
    runId,
    position,
    promise,
    abort: () => entry.signalController.abort(),
    unsubscribe: () => {
      if (!entryCb) return
      const idx = entry.onEvents.indexOf(entryCb)
      if (idx >= 0) entry.onEvents.splice(idx, 1)
    },
  }
}
