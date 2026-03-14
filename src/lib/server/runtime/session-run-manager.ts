import { genId } from '@/lib/id'
import type {
  RunEventRecord,
  SessionRunHeartbeatConfig,
  SessionQueueSnapshot,
  SessionQueuedTurn,
  SessionRunRecord,
  SessionRunStatus,
  SSEEvent,
} from '@/types'
import {
  active,
  isRuntimeLockActive,
  loadSession,
  releaseRuntimeLock,
  tryAcquireRuntimeLock,
} from '@/lib/server/storage'
import { executeSessionChatTurn, type ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { log } from '@/lib/server/logger'
import { isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'
import { cleanupSessionBrowser } from '@/lib/server/session-tools/web'
import { cancelDelegationJobsForParentSession } from '@/lib/server/agents/delegation-jobs'
import { getMainLoopStateForSession, handleMainLoopRunResult } from '@/lib/server/agents/main-agent-loop'
import { observeAutonomyRunOutcome } from '@/lib/server/autonomy/supervisor-reflection'
import { observeLearnedSkillRunOutcome } from '@/lib/server/skills/learned-skills'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import { getEnabledToolIds } from '@/lib/capability-selection'
import {
  appendPersistedRunEvent,
  isRestartRecoverableSource,
  listPersistedRunEvents,
  listPersistedRuns,
  loadPersistedRun,
  loadRecoverableStaleRuns,
  patchPersistedRun,
  persistRun,
} from '@/lib/server/runtime/run-ledger'
import { isAllEstopEngaged, isAutonomyEstopEngaged } from '@/lib/server/runtime/estop'
import { notify } from '@/lib/server/ws-hub'

export type SessionQueueMode = 'followup' | 'steer' | 'collect'

interface QueueEntry {
  executionKey: string
  run: SessionRunRecord
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  onEvents: Array<(event: SSEEvent) => void>
  signalController: AbortController
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: SessionRunHeartbeatConfig
  replyToId?: string
  resolve: (value: ExecuteChatTurnResult) => void
  reject: (error: Error) => void
  promise: Promise<ExecuteChatTurnResult>
}

interface RuntimeState {
  runningByExecution: Map<string, QueueEntry>
  queueByExecution: Map<string, QueueEntry[]>
  runs: Map<string, SessionRunRecord>
  recentRunIds: string[]
  promises: Map<string, Promise<ExecuteChatTurnResult>>
  deferredDrainTimers: Map<string, ReturnType<typeof setTimeout>>
  activityLeaseRenewTimers: Map<string, ReturnType<typeof setInterval>>
  externalSessionHolds: Map<string, number>
  lastQueuedAt: number
}

const MAX_RECENT_RUNS = 500
const COLLECT_COALESCE_WINDOW_MS = 1500
const SHARED_ACTIVITY_LEASE_TTL_MS = 15_000
const SHARED_ACTIVITY_LEASE_RENEW_MS = 5_000
const HEARTBEAT_BUSY_RETRY_MS = 1_000
const STALE_QUEUED_RUN_MS = 15_000
const SHARED_ACTIVITY_LEASE_OWNER = `session-run:${process.pid}:${genId(6)}`
const state: RuntimeState = hmrSingleton<RuntimeState>('__swarmclaw_session_run_manager__', () => ({
  runningByExecution: new Map<string, QueueEntry>(),
  queueByExecution: new Map<string, QueueEntry[]>(),
  runs: new Map<string, SessionRunRecord>(),
  recentRunIds: [],
  promises: new Map<string, Promise<ExecuteChatTurnResult>>(),
  deferredDrainTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  activityLeaseRenewTimers: new Map<string, ReturnType<typeof setInterval>>(),
  externalSessionHolds: new Map<string, number>(),
  lastQueuedAt: 0,
}))
const recoveryState = hmrSingleton('__swarmclaw_session_run_recovery__', () => ({ completed: false }))

// Backfill fields for hot-reloaded state objects created by older code versions.
if (!state.runningByExecution) state.runningByExecution = new Map<string, QueueEntry>()
if (!state.queueByExecution) state.queueByExecution = new Map<string, QueueEntry[]>()
if (!state.runs) state.runs = new Map<string, SessionRunRecord>()
if (!state.recentRunIds) state.recentRunIds = []
if (!state.promises) state.promises = new Map<string, Promise<ExecuteChatTurnResult>>()
if (!state.deferredDrainTimers) state.deferredDrainTimers = new Map<string, ReturnType<typeof setTimeout>>()
if (!state.activityLeaseRenewTimers) state.activityLeaseRenewTimers = new Map<string, ReturnType<typeof setInterval>>()
if (!state.externalSessionHolds) state.externalSessionHolds = new Map<string, number>()
if (typeof state.lastQueuedAt !== 'number') state.lastQueuedAt = 0

function now() {
  return Date.now()
}

function nextQueuedAt() {
  const current = now()
  const next = current <= state.lastQueuedAt ? state.lastQueuedAt + 1 : current
  state.lastQueuedAt = next
  return next
}

function messagePreview(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 140)
}

function trimRecentRuns() {
  while (state.recentRunIds.length > MAX_RECENT_RUNS) {
    const id = state.recentRunIds.shift()
    if (!id) continue
    state.runs.delete(id)
    state.promises.delete(id)
  }
}

function syncRunRecord(run: SessionRunRecord): SessionRunRecord {
  state.runs.set(run.id, run)
  persistRun(run)
  return run
}

function registerRun(run: SessionRunRecord) {
  syncRunRecord(run)
  state.recentRunIds.push(run.id)
  trimRecentRuns()
}

function shouldPersistRunEvent(event: SSEEvent): boolean {
  return event.t !== 'd' && event.t !== 'thinking' && event.t !== 'reset'
}

function persistEventForRun(entry: QueueEntry, event: SSEEvent, opts?: {
  phase?: RunEventRecord['phase']
  status?: SessionRunStatus
  summary?: string
}): void {
  if (!shouldPersistRunEvent(event)) return
  appendPersistedRunEvent({
    runId: entry.run.id,
    sessionId: entry.run.sessionId,
    phase: opts?.phase || 'event',
    status: opts?.status,
    summary: opts?.summary,
    event,
  })
}

/** Chain an external AbortSignal to an internal AbortController so that
 *  when the caller (e.g. HTTP request) disconnects, the run is cancelled. */
function chainCallerSignal(callerSignal: AbortSignal, controller: AbortController): void {
  if (callerSignal.aborted) {
    controller.abort()
    return
  }
  const onAbort = () => controller.abort()
  callerSignal.addEventListener('abort', onAbort, { once: true })
}

function emitToSubscribers(entry: QueueEntry, event: SSEEvent) {
  persistEventForRun(entry, event)
  for (const send of entry.onEvents) {
    try {
      send(event)
    } catch {
      // Subscriber stream can be closed by the client.
    }
  }
}

function emitRunMeta(entry: QueueEntry, status: SessionRunStatus, extra?: Record<string, unknown>) {
  const event: SSEEvent = {
    t: 'md',
    text: JSON.stringify({
      run: {
        id: entry.run.id,
        sessionId: entry.run.sessionId,
        status,
        source: entry.run.source,
        internal: entry.run.internal,
        ...extra,
      },
    }),
  }
  persistEventForRun(entry, event, { phase: 'status', status })
  for (const send of entry.onEvents) {
    try {
      send(event)
    } catch {
      // Subscriber stream can be closed by the client.
    }
  }
  notifySessionRunState(entry.run.sessionId)
}

function notifySessionRunState(sessionId: string): void {
  notify('runs')
  notify('sessions')
  notify(`session:${sessionId}`)
}

function queueAutonomyObservation(input: {
  runId: string
  sessionId: string
  source: string
  status: SessionRunStatus
  resultText?: string | null
  error?: string | null
  toolEvents?: ExecuteChatTurnResult['toolEvents']
  sourceMessage?: string | null
}) {
  const session = loadSession(input.sessionId)
  void observeAutonomyRunOutcome({
    runId: input.runId,
    sessionId: input.sessionId,
    agentId: session?.agentId || null,
    source: input.source,
    status: input.status,
    resultText: input.resultText,
    error: input.error || undefined,
    toolEvents: input.toolEvents,
    mainLoopState: getMainLoopStateForSession(input.sessionId),
    sourceMessage: input.sourceMessage,
  }).then(({ reflection }) => observeLearnedSkillRunOutcome({
    runId: input.runId,
    sessionId: input.sessionId,
    agentId: session?.agentId || null,
    source: input.source,
    status: input.status,
    resultText: input.resultText,
    error: input.error || undefined,
    toolEvents: input.toolEvents,
    reflection,
  })).catch((err: unknown) => {
    log.warn('session-run', `Autonomy observation failed for ${input.runId}`, {
      sessionId: input.sessionId,
      error: errorMessage(err),
    })
  })
}

function markRunningEntryCancelled(entry: QueueEntry, reason: string) {
  if (entry.run.status === 'cancelled') return
  entry.run.status = 'cancelled'
  entry.run.endedAt = now()
  entry.run.error = reason
  syncRunRecord(entry.run)
  emitRunMeta(entry, 'cancelled', { reason })
}

function abortSessionRuntime(entry: QueueEntry, reason: string) {
  markRunningEntryCancelled(entry, reason)
  entry.signalController.abort()
  try { active.get(entry.run.sessionId)?.kill?.() } catch { /* noop */ }
  active.delete(entry.run.sessionId)
  try { cleanupSessionBrowser(entry.run.sessionId) } catch { /* noop */ }
  try { cancelDelegationJobsForParentSession(entry.run.sessionId, reason) } catch { /* noop */ }
}

function executionKeyForSession(sessionId: string): string {
  return `session:${sessionId}`
}

function nonHeartbeatActivityLeaseName(sessionId: string): string {
  return `session-non-heartbeat:${sessionId}`
}

export function hasActiveNonHeartbeatSessionLease(sessionId: string): boolean {
  return isRuntimeLockActive(nonHeartbeatActivityLeaseName(sessionId))
}

function hasExternalSessionExecutionHold(sessionId: string): boolean {
  return (state.externalSessionHolds.get(sessionId) || 0) > 0
}

export function acquireExternalSessionExecutionHold(sessionId: string): () => void {
  const current = state.externalSessionHolds.get(sessionId) || 0
  state.externalSessionHolds.set(sessionId, current + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (state.externalSessionHolds.get(sessionId) || 1) - 1
    if (next > 0) state.externalSessionHolds.set(sessionId, next)
    else state.externalSessionHolds.delete(sessionId)
    void drainExecution(executionKeyForSession(sessionId))
  }
}

function queueForExecution(executionKey: string): QueueEntry[] {
  const existing = state.queueByExecution.get(executionKey)
  if (existing) return existing
  const created: QueueEntry[] = []
  state.queueByExecution.set(executionKey, created)
  return created
}

function normalizeMode(mode: string | undefined, internal: boolean): SessionQueueMode {
  if (mode === 'steer' || mode === 'collect' || mode === 'followup') return mode
  return internal ? 'collect' : 'followup'
}

function markPersistedRunInterrupted(run: SessionRunRecord, reason: string): SessionRunRecord {
  const interruptedAt = now()
  const next = patchPersistedRun(run.id, (current) => {
    const target = current || run
    return {
      ...target,
      status: 'cancelled',
      endedAt: target.endedAt || interruptedAt,
      interruptedAt,
      interruptedReason: reason,
      error: target.error || reason,
    }
  }) || {
    ...run,
    status: 'cancelled',
    endedAt: run.endedAt || interruptedAt,
    interruptedAt,
    interruptedReason: reason,
    error: run.error || reason,
  }
  state.runs.set(next.id, next)
  if (!state.recentRunIds.includes(next.id)) {
    state.recentRunIds.push(next.id)
    trimRecentRuns()
  }
  appendPersistedRunEvent({
    runId: next.id,
    sessionId: next.sessionId,
    phase: 'status',
    status: 'cancelled',
    summary: reason,
    event: {
      t: 'md',
      text: JSON.stringify({
        run: {
          id: next.id,
          sessionId: next.sessionId,
          status: 'cancelled',
          interrupted: true,
          reason,
        },
      }),
    },
  })
  return next
}

function ensureRecoveredPersistedRuns(): void {
  if (recoveryState.completed) return
  recoveryState.completed = true
  const staleRuns = loadRecoverableStaleRuns()
  if (!staleRuns.length) return
  const recoveryBlocked = isAutonomyEstopEngaged() || isAllEstopEngaged()

  for (const run of staleRuns) {
    const interrupted = markPersistedRunInterrupted(run, 'Interrupted by server restart before the run completed.')
    const payload = interrupted.recoveryPayload
    if (
      recoveryBlocked
      || interrupted.recoveredFromRestart
      || !payload
      || !isRestartRecoverableSource(interrupted.source)
    ) {
      continue
    }

    try {
      enqueueSessionRun({
        sessionId: interrupted.sessionId,
        message: payload.message,
        imagePath: payload.imagePath,
        imageUrl: payload.imageUrl,
        attachedFiles: payload.attachedFiles,
        internal: payload.internal,
        source: payload.source,
        mode: normalizeMode(payload.mode, payload.internal),
        dedupeKey: interrupted.dedupeKey,
        maxRuntimeMs: payload.maxRuntimeMs,
        modelOverride: payload.modelOverride,
        heartbeatConfig: payload.heartbeatConfig,
        replyToId: payload.replyToId,
        executionGroupKey: payload.executionGroupKey,
        recoveredFromRestart: true,
        recoveredFromRunId: interrupted.id,
      })
    } catch (err: unknown) {
      log.warn('session-run', `Failed to requeue interrupted run ${interrupted.id}`, {
        sessionId: interrupted.sessionId,
        error: errorMessage(err),
      })
    }
  }
}

function hasLocalNonHeartbeatWork(sessionId: string): boolean {
  const running = Array.from(state.runningByExecution.values())
    .some((entry) => entry.run.sessionId === sessionId && !isInternalHeartbeatRun(entry.run.internal, entry.run.source))
  if (running) return true
  return Array.from(state.queueByExecution.values())
    .flatMap((queue) => queue)
    .some((entry) => entry.run.sessionId === sessionId && !isInternalHeartbeatRun(entry.run.internal, entry.run.source))
}

function clearDeferredDrain(executionKey: string): void {
  const timer = state.deferredDrainTimers.get(executionKey)
  if (!timer) return
  clearTimeout(timer)
  state.deferredDrainTimers.delete(executionKey)
}

function deleteQueueEntry(queue: QueueEntry[], target: QueueEntry): boolean {
  const idx = queue.indexOf(target)
  if (idx === -1) return false
  queue.splice(idx, 1)
  return true
}

function scheduleDeferredDrain(executionKey: string, delayMs = HEARTBEAT_BUSY_RETRY_MS): void {
  if (state.deferredDrainTimers.has(executionKey)) return
  const timer = setTimeout(() => {
    state.deferredDrainTimers.delete(executionKey)
    void drainExecution(executionKey)
  }, delayMs)
  state.deferredDrainTimers.set(executionKey, timer)
}

function stopSessionActivityLease(sessionId: string): void {
  const timer = state.activityLeaseRenewTimers.get(sessionId)
  if (timer) {
    clearInterval(timer)
    state.activityLeaseRenewTimers.delete(sessionId)
  }
  releaseRuntimeLock(nonHeartbeatActivityLeaseName(sessionId), SHARED_ACTIVITY_LEASE_OWNER)
}

function startSessionActivityLease(sessionId: string): void {
  if (state.activityLeaseRenewTimers.has(sessionId)) return
  const leaseName = nonHeartbeatActivityLeaseName(sessionId)
  tryAcquireRuntimeLock(leaseName, SHARED_ACTIVITY_LEASE_OWNER, SHARED_ACTIVITY_LEASE_TTL_MS)
  const timer = setInterval(() => {
    if (!hasLocalNonHeartbeatWork(sessionId)) {
      stopSessionActivityLease(sessionId)
      return
    }
    tryAcquireRuntimeLock(leaseName, SHARED_ACTIVITY_LEASE_OWNER, SHARED_ACTIVITY_LEASE_TTL_MS)
  }, SHARED_ACTIVITY_LEASE_RENEW_MS)
  state.activityLeaseRenewTimers.set(sessionId, timer)
}

function reconcileSessionActivityLease(sessionId: string): void {
  if (hasLocalNonHeartbeatWork(sessionId)) startSessionActivityLease(sessionId)
  else stopSessionActivityLease(sessionId)
}

function resolveRecoveredQueuedEntry(entry: QueueEntry, reason: string): void {
  if (entry.run.status === 'completed' || entry.run.status === 'failed' || entry.run.status === 'cancelled') {
    entry.run.endedAt = entry.run.endedAt || now()
  } else {
    entry.run.status = 'failed'
    entry.run.endedAt = now()
  }
  entry.run.error = reason
  syncRunRecord(entry.run)
  emitToSubscribers(entry, { t: 'err', text: reason })
  emitRunMeta(entry, 'failed', {
    error: reason,
    recovered: true,
  })
  entry.resolve({
    runId: entry.run.id,
    sessionId: entry.run.sessionId,
    text: '',
    persisted: false,
    toolEvents: [],
    error: reason,
  })
}

export function repairSessionRunQueue(
  sessionId: string,
  opts?: {
    executionKey?: string
    maxQueuedAgeMs?: number
    reason?: string
  },
): {
  kickedExecutionKeys: number
  recoveredQueuedRuns: number
} {
  const maxQueuedAgeMs = Math.max(1_000, opts?.maxQueuedAgeMs ?? STALE_QUEUED_RUN_MS)
  const reason = opts?.reason || 'Recovered stale queued run'
  const targetExecutionKey = typeof opts?.executionKey === 'string' && opts.executionKey.trim()
    ? opts.executionKey.trim()
    : null
  const queuedNow = now()
  let kickedExecutionKeys = 0
  let recoveredQueuedRuns = 0

  for (const [executionKey, queue] of state.queueByExecution.entries()) {
    if (targetExecutionKey && executionKey !== targetExecutionKey) continue
    if (!queue.length) {
      clearDeferredDrain(executionKey)
      state.queueByExecution.delete(executionKey)
      continue
    }
    if (state.runningByExecution.has(executionKey)) continue

    const matching = queue.filter((entry) => entry.run.sessionId === sessionId)
    if (!matching.length) continue

    for (const entry of [...matching]) {
      const missingPromise = !state.promises.has(entry.run.id)
      const previousStatus = entry.run.status
      const nonQueued = previousStatus !== 'queued'
      const ageMs = Math.max(0, queuedNow - (entry.run.queuedAt || 0))
      const stale = nonQueued || missingPromise || ageMs >= maxQueuedAgeMs
      if (!stale) continue
      if (!deleteQueueEntry(queue, entry)) continue
      clearDeferredDrain(executionKey)
      resolveRecoveredQueuedEntry(entry, reason)
      recoveredQueuedRuns += 1
      log.warn('session-run', `Recovered stale queued run ${entry.run.id}`, {
        sessionId: entry.run.sessionId,
        executionKey,
        source: entry.run.source,
        ageMs,
        missingPromise,
        previousStatus,
      })
    }

    if (!queue.length) {
      clearDeferredDrain(executionKey)
      state.queueByExecution.delete(executionKey)
      continue
    }

    if (queue.some((entry) => entry.run.sessionId === sessionId)) {
      clearDeferredDrain(executionKey)
      kickedExecutionKeys += 1
      void drainExecution(executionKey)
    }
  }

  if (recoveredQueuedRuns > 0) reconcileSessionActivityLease(sessionId)
  return { kickedExecutionKeys, recoveredQueuedRuns }
}

function cancelPendingForSession(sessionId: string, reason: string): number {
  let cancelled = 0
  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: QueueEntry[] = []
    for (const entry of queue) {
      if (entry.run.sessionId !== sessionId) {
        keep.push(entry)
        continue
      }
      entry.run.status = 'cancelled'
      entry.run.endedAt = now()
      entry.run.error = reason
      syncRunRecord(entry.run)
      emitRunMeta(entry, 'cancelled', { reason })
      entry.reject(new Error(reason))
      cancelled++
    }
    if (keep.length > 0) state.queueByExecution.set(key, keep)
    else state.queueByExecution.delete(key)
  }
  reconcileSessionActivityLease(sessionId)
  return cancelled
}

function cancelQueuedEntries(
  matcher: (entry: QueueEntry) => boolean,
  reason: string,
): { cancelled: number; sessionIds: Set<string> } {
  let cancelled = 0
  const sessionIds = new Set<string>()
  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: QueueEntry[] = []
    for (const entry of queue) {
      if (!matcher(entry)) {
        keep.push(entry)
        continue
      }
      entry.run.status = 'cancelled'
      entry.run.endedAt = now()
      entry.run.error = reason
      syncRunRecord(entry.run)
      emitRunMeta(entry, 'cancelled', { reason })
      entry.reject(new Error(reason))
      sessionIds.add(entry.run.sessionId)
      cancelled += 1
    }
    if (keep.length > 0) state.queueByExecution.set(key, keep)
    else state.queueByExecution.delete(key)
  }
  for (const sessionId of sessionIds) reconcileSessionActivityLease(sessionId)
  return { cancelled, sessionIds }
}

export function cancelAllHeartbeatRuns(reason = 'Heartbeat disabled globally'): { cancelledQueued: number; abortedRunning: number } {
  ensureRecoveredPersistedRuns()
  let cancelledQueued = 0
  let abortedRunning = 0

  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: QueueEntry[] = []
    for (const entry of queue) {
      const isHeartbeat = isInternalHeartbeatRun(entry.run.internal, entry.run.source)
      if (!isHeartbeat) {
        keep.push(entry)
        continue
      }
      entry.run.status = 'cancelled'
      entry.run.endedAt = now()
      entry.run.error = reason
      syncRunRecord(entry.run)
      emitRunMeta(entry, 'cancelled', { reason })
      entry.reject(new Error(reason))
      cancelledQueued += 1
    }
    if (keep.length > 0) state.queueByExecution.set(key, keep)
    else state.queueByExecution.delete(key)
  }

  for (const entry of state.runningByExecution.values()) {
    const isHeartbeat = isInternalHeartbeatRun(entry.run.internal, entry.run.source)
    if (!isHeartbeat) continue
    abortedRunning += 1
    abortSessionRuntime(entry, reason)
  }

  return { cancelledQueued, abortedRunning }
}

export function cancelAllRuns(reason = 'Cancelled'): { cancelledQueued: number; abortedRunning: number } {
  ensureRecoveredPersistedRuns()
  let cancelledQueued = 0
  let abortedRunning = 0

  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    for (const entry of queue) {
      entry.run.status = 'cancelled'
      entry.run.endedAt = now()
      entry.run.error = reason
      syncRunRecord(entry.run)
      emitRunMeta(entry, 'cancelled', { reason })
      entry.reject(new Error(reason))
      cancelledQueued += 1
    }
    state.queueByExecution.delete(key)
  }

  for (const entry of state.runningByExecution.values()) {
    abortedRunning += 1
    abortSessionRuntime(entry, reason)
  }
  state.runningByExecution.clear()

  return { cancelledQueued, abortedRunning }
}

async function drainExecution(executionKey: string): Promise<void> {
  if (state.runningByExecution.has(executionKey)) return
  const q = queueForExecution(executionKey)
  // Priority: user (non-heartbeat) runs go first. If a heartbeat is queued
  // behind a user run, the user run takes priority.
  const userIdx = q.findIndex(e => !isInternalHeartbeatRun(e.run.internal, e.run.source))
  const next = userIdx >= 0 ? q.splice(userIdx, 1)[0] : q.shift()
  if (!next) {
    clearDeferredDrain(executionKey)
    return
  }

  if (isInternalHeartbeatRun(next.run.internal, next.run.source) && hasActiveNonHeartbeatSessionLease(next.run.sessionId)) {
    q.unshift(next)
    scheduleDeferredDrain(executionKey, HEARTBEAT_BUSY_RETRY_MS)
    log.info('session-run', `Deferred heartbeat run ${next.run.id} for shared busy session`, {
      sessionId: next.run.sessionId,
      source: next.run.source,
      leaseName: nonHeartbeatActivityLeaseName(next.run.sessionId),
    })
    return
  }

  if (hasExternalSessionExecutionHold(next.run.sessionId)) {
    q.unshift(next)
    scheduleDeferredDrain(executionKey, HEARTBEAT_BUSY_RETRY_MS)
    log.info('session-run', `Deferred run ${next.run.id} for external session hold`, {
      sessionId: next.run.sessionId,
      source: next.run.source,
      mode: next.run.mode,
    })
    return
  }

  clearDeferredDrain(executionKey)
  state.runningByExecution.set(executionKey, next)
  next.run.status = 'running'
  next.run.startedAt = now()
  syncRunRecord(next.run)
  emitRunMeta(next, 'running')
  log.info('session-run', `Run started ${next.run.id}`, {
    sessionId: next.run.sessionId,
    source: next.run.source,
    internal: next.run.internal,
    mode: next.run.mode,
    timeoutMs: next.maxRuntimeMs || null,
  })

  let runtimeTimer: ReturnType<typeof setTimeout> | null = null
  if (next.maxRuntimeMs && next.maxRuntimeMs > 0) {
    runtimeTimer = setTimeout(() => {
      next.signalController.abort()
    }, next.maxRuntimeMs)
  }

  try {
    const result = await executeSessionChatTurn({
      sessionId: next.run.sessionId,
      message: next.message,
      imagePath: next.imagePath,
      imageUrl: next.imageUrl,
      attachedFiles: next.attachedFiles,
      internal: next.run.internal,
      source: next.run.source,
      runId: next.run.id,
      signal: next.signalController.signal,
      onEvent: (event) => emitToSubscribers(next, event),
      modelOverride: next.modelOverride,
      heartbeatConfig: next.heartbeatConfig,
      replyToId: next.replyToId,
    })

    const failed = !!result.error
    const aborted = next.signalController.signal.aborted
    next.run.status = aborted ? 'cancelled' : (failed ? 'failed' : 'completed')
    next.run.endedAt = next.run.endedAt || now()
    next.run.error = aborted ? (next.run.error || 'Cancelled') : result.error
    next.run.resultPreview = result.text?.slice(0, 280)
    syncRunRecord(next.run)
    emitRunMeta(next, next.run.status, {
      persisted: result.persisted,
      hasText: !!result.text,
      error: next.run.error || null,
    })
    log.info('session-run', `Run finished ${next.run.id}`, {
      sessionId: next.run.sessionId,
      status: next.run.status,
      persisted: result.persisted,
      hasText: !!result.text,
      error: next.run.error || null,
      durationMs: (next.run.endedAt || now()) - (next.run.startedAt || now()),
    })
    const followup = handleMainLoopRunResult({
      runId: next.run.id,
      sessionId: next.run.sessionId,
      message: next.message,
      internal: next.run.internal,
      source: next.run.source,
      resultText: result.text,
      error: next.run.error,
      toolEvents: result.toolEvents,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCost: result.estimatedCost,
    })
    queueAutonomyObservation({
      runId: next.run.id,
      sessionId: next.run.sessionId,
      source: next.run.source,
      status: next.run.status,
      resultText: result.text,
      error: next.run.error || null,
      toolEvents: result.toolEvents,
      sourceMessage: next.message,
    })
    if (followup) {
      setTimeout(() => {
        try {
          enqueueSessionRun({
            sessionId: next.run.sessionId,
            message: followup.message,
            internal: true,
            source: 'main-loop-followup',
            mode: 'followup',
            dedupeKey: followup.dedupeKey,
          })
        } catch (err: unknown) {
          log.warn('session-run', `Main loop follow-up enqueue failed for ${next.run.sessionId}`, {
            error: errorMessage(err),
          })
        }
      }, Math.max(0, followup.delayMs || 0))
    }
    next.resolve(result)
  } catch (err: unknown) {
    const aborted = next.signalController.signal.aborted
    next.run.status = aborted ? 'cancelled' : 'failed'
    next.run.endedAt = now()
    next.run.error = errorMessage(err)
    syncRunRecord(next.run)
    emitRunMeta(next, next.run.status, { error: next.run.error })
    log.error('session-run', `Run failed ${next.run.id}`, {
      sessionId: next.run.sessionId,
      status: next.run.status,
      error: next.run.error,
      durationMs: (next.run.endedAt || now()) - (next.run.startedAt || now()),
    })
    queueAutonomyObservation({
      runId: next.run.id,
      sessionId: next.run.sessionId,
      source: next.run.source,
      status: next.run.status,
      error: next.run.error || null,
      sourceMessage: next.message,
    })
    next.reject(err instanceof Error ? err : new Error(next.run.error))
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer)
    state.runningByExecution.delete(executionKey)
    reconcileSessionActivityLease(next.run.sessionId)
    void drainExecution(executionKey)
  }
}

function findDedupeMatch(sessionId: string, dedupeKey?: string): QueueEntry | null {
  if (!dedupeKey) return null
  const executionKey = executionKeyForSession(sessionId)
  const running = state.runningByExecution.get(executionKey)
  if (running?.run.sessionId === sessionId && running?.run.dedupeKey === dedupeKey) return running
  const q = queueForExecution(executionKey)
  return q.find((e) => e.run.sessionId === sessionId && e.run.dedupeKey === dedupeKey) || null
}

export interface EnqueueSessionRunInput {
  sessionId: string
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  internal?: boolean
  source?: string
  mode?: SessionQueueMode
  onEvent?: (event: SSEEvent) => void
  dedupeKey?: string
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: SessionRunHeartbeatConfig
  replyToId?: string
  /** Optional shared execution lane key. When set, multiple sessions can be serialized together. */
  executionGroupKey?: string
  /** External abort signal (e.g. from the HTTP request) — chained to the run's internal AbortController */
  callerSignal?: AbortSignal
  recoveredFromRestart?: boolean
  recoveredFromRunId?: string
}

export interface EnqueueSessionRunResult {
  runId: string
  position: number
  deduped?: boolean
  coalesced?: boolean
  promise: Promise<ExecuteChatTurnResult>
  /** Abort the run's internal AbortController (cancels the LLM stream). */
  abort: () => void
  /** Remove this caller's onEvent listener from the run (call on client disconnect). */
  unsubscribe: () => void
}

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
  const hasLongTool = sessionTools.some(t => LONG_TOOL_NAMES.has(t))
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

export function enqueueSessionRun(input: EnqueueSessionRunInput): EnqueueSessionRunResult {
  ensureRecoveredPersistedRuns()
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
  repairSessionRunQueue(input.sessionId, {
    executionKey,
    reason: 'Recovered stale queued run before enqueue',
  })
  const runtime = loadRuntimeSettings()
  const defaultMaxRuntimeMs = runtime.ongoingLoopMaxRuntimeMs ?? (10 * 60_000)
  const sessionData = loadSession(input.sessionId) as SessionToolConfig | null
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
      try { active.get(input.sessionId)?.kill?.() } catch { /* noop */ }
    }
    cancelPendingForSession(input.sessionId, 'Cancelled by steer mode')
  }

  // Heartbeat preemption: if a user chat arrives while a heartbeat is running,
  // abort the heartbeat so the user doesn't wait. The heartbeat will retry
  // on the next tick.
  if (!internal && source === 'chat') {
    const running = state.runningByExecution.get(executionKey)
    if (running && isInternalHeartbeatRun(running.run.internal, running.run.source)) {
      log.info('session-run', `Preempting heartbeat ${running.run.id} for user chat on ${input.sessionId}`)
      abortSessionRuntime(running, 'Preempted by user chat')
      state.runningByExecution.delete(executionKey)
    }
  }

  const running = state.runningByExecution.get(executionKey)
  const q = queueForExecution(executionKey)
  if (mode === 'collect' && !input.imagePath && !input.imageUrl && !input.attachedFiles?.length) {
  const nowMs = nextQueuedAt()
    const candidate = q.at(-1)
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

  let resolve!: (value: ExecuteChatTurnResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ExecuteChatTurnResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  state.promises.set(runId, promise)

  const entry: QueueEntry = {
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

  q.push(entry)
  if (!isInternalHeartbeatRun(internal, source)) reconcileSessionActivityLease(input.sessionId)
  const position = (running ? 1 : 0) + q.length - 1
  emitRunMeta(entry, 'queued', { position })
  void drainExecution(executionKey)

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

export function getSessionRunState(sessionId: string): {
  runningRunId?: string
  queueLength: number
} {
  ensureRecoveredPersistedRuns()
  const summary = getSessionExecutionState(sessionId)
  return {
    runningRunId: summary.runningRunId,
    queueLength: summary.queueLength,
  }
}

function visibleQueuedEntriesForSession(sessionId: string): QueueEntry[] {
  return Array.from(state.queueByExecution.values())
    .flatMap((queue) => queue)
    .filter((entry) => entry.run.sessionId === sessionId && entry.run.internal !== true)
    .sort((left, right) => left.run.queuedAt - right.run.queuedAt)
}

function toQueuedTurn(entry: QueueEntry, index: number): SessionQueuedTurn {
  return {
    runId: entry.run.id,
    sessionId: entry.run.sessionId,
    text: entry.message,
    queuedAt: entry.run.queuedAt,
    position: index + 1,
    imagePath: entry.imagePath,
    imageUrl: entry.imageUrl,
    attachedFiles: entry.attachedFiles,
    replyToId: entry.replyToId,
    source: entry.run.source,
  }
}

export function getSessionQueueSnapshot(sessionId: string): SessionQueueSnapshot {
  ensureRecoveredPersistedRuns()
  const execution = getSessionExecutionState(sessionId)
  const visibleQueued = visibleQueuedEntriesForSession(sessionId)
  return {
    sessionId,
    activeRunId: execution.runningRunId || null,
    queueLength: visibleQueued.length,
    items: visibleQueued.map((entry, index) => toQueuedTurn(entry, index)),
  }
}

export function getSessionExecutionState(sessionId: string): {
  runningRunId?: string
  queueLength: number
  hasRunning: boolean
  hasQueued: boolean
  hasRunningHeartbeat: boolean
  hasQueuedHeartbeat: boolean
  hasRunningNonHeartbeat: boolean
  hasQueuedNonHeartbeat: boolean
} {
  ensureRecoveredPersistedRuns()
  const running = Array.from(state.runningByExecution.values())
    .find((entry) => entry.run.sessionId === sessionId)
  const runningMatchesSession = Boolean(running)
  const runningHeartbeat = Boolean(
    runningMatchesSession
    && running
    && isInternalHeartbeatRun(running.run.internal, running.run.source),
  )
  const runningNonHeartbeat = Boolean(runningMatchesSession && !runningHeartbeat)
  const queuedEntries = Array.from(state.queueByExecution.values())
    .flatMap((queue) => queue)
    .filter((entry) => entry.run.sessionId === sessionId)
  const queuedHeartbeat = queuedEntries.filter((entry) =>
    isInternalHeartbeatRun(entry.run.internal, entry.run.source),
  ).length
  const queuedNonHeartbeat = queuedEntries.length - queuedHeartbeat
  return {
    runningRunId: (runningMatchesSession && running?.run.status === 'running')
      ? running.run.id
      : undefined,
    queueLength: queuedEntries.length,
    hasRunning: Boolean(runningMatchesSession),
    hasQueued: queuedEntries.length > 0,
    hasRunningHeartbeat: runningHeartbeat,
    hasQueuedHeartbeat: queuedHeartbeat > 0,
    hasRunningNonHeartbeat: runningNonHeartbeat,
    hasQueuedNonHeartbeat: queuedNonHeartbeat > 0,
  }
}

export function getRunById(runId: string): SessionRunRecord | null {
  ensureRecoveredPersistedRuns()
  return state.runs.get(runId) || loadPersistedRun(runId)
}

export function listRuns(params?: {
  sessionId?: string
  status?: SessionRunStatus
  limit?: number
}): SessionRunRecord[] {
  ensureRecoveredPersistedRuns()
  return listPersistedRuns(params)
}

export function listRunEvents(runId: string, limit?: number): RunEventRecord[] {
  ensureRecoveredPersistedRuns()
  return listPersistedRunEvents(runId, limit)
}

export function cancelQueuedRunById(runId: string, reason = 'Removed from queue'): boolean {
  ensureRecoveredPersistedRuns()
  const result = cancelQueuedEntries((entry) => entry.run.id === runId, reason)
  return result.cancelled > 0
}

export function cancelQueuedRunsForSession(sessionId: string, reason = 'Cleared queued messages'): number {
  ensureRecoveredPersistedRuns()
  const result = cancelQueuedEntries((entry) => entry.run.sessionId === sessionId, reason)
  return result.cancelled
}

export function cancelSessionRuns(sessionId: string, reason = 'Cancelled'): { cancelledQueued: number; cancelledRunning: boolean } {
  ensureRecoveredPersistedRuns()
  const running = Array.from(state.runningByExecution.values())
    .find((entry) => entry.run.sessionId === sessionId)
  let cancelledRunning = false
  if (running) {
    cancelledRunning = true
    abortSessionRuntime(running, reason)
    state.runningByExecution.delete(running.executionKey)
  }
  const cancelledQueued = cancelPendingForSession(sessionId, reason)
  reconcileSessionActivityLease(sessionId)
  return { cancelledQueued, cancelledRunning }
}

export function resetSessionRunManagerForTests(): void {
  recoveryState.completed = false
  for (const timer of state.deferredDrainTimers.values()) clearTimeout(timer)
  state.deferredDrainTimers.clear()
  for (const [sessionId, timer] of state.activityLeaseRenewTimers.entries()) {
    clearInterval(timer)
    releaseRuntimeLock(nonHeartbeatActivityLeaseName(sessionId), SHARED_ACTIVITY_LEASE_OWNER)
  }
  state.activityLeaseRenewTimers.clear()
  state.runningByExecution.clear()
  state.queueByExecution.clear()
  state.runs.clear()
  state.recentRunIds.length = 0
  state.promises.clear()
  state.externalSessionHolds.clear()
  state.lastQueuedAt = 0
}
