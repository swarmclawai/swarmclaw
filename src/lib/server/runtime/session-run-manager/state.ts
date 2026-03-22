import { genId } from '@/lib/id'
import type { RunEventRecord, SessionRunRecord, SessionRunStatus, SSEEvent } from '@/types'
import {
  isRuntimeLockActive,
  releaseRuntimeLock,
  tryAcquireRuntimeLock,
} from '@/lib/server/runtime/runtime-lock-repository'
import { getSession } from '@/lib/server/sessions/session-repository'
import { log } from '@/lib/server/logger'
import { isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'
import { cleanupSessionBrowser } from '@/lib/server/session-tools/web'
import { cancelDelegationJobsForParentSession } from '@/lib/server/agents/delegation-jobs'
import { getMainLoopStateForSession } from '@/lib/server/agents/main-agent-loop'
import { observeAutonomyRunOutcome } from '@/lib/server/autonomy/supervisor-reflection'
import { observeLearnedSkillRunOutcome } from '@/lib/server/skills/learned-skills'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import {
  appendPersistedRunEvent,
  patchPersistedRun,
  persistRun,
} from '@/lib/server/runtime/run-ledger'
import { getActiveSessionProcess, stopActiveSessionProcess } from '@/lib/server/runtime/runtime-state'
import { notify } from '@/lib/server/ws-hub'
import type { SessionRunManagerState, SessionRunQueueEntry, SessionQueueMode } from './types'

export const MAX_RECENT_RUNS = 500
export const COLLECT_COALESCE_WINDOW_MS = 1500
export const SHARED_ACTIVITY_LEASE_TTL_MS = 15_000
export const SHARED_ACTIVITY_LEASE_RENEW_MS = 5_000
export const EXTERNAL_HOLD_TTL_MS = 60_000
export const MAX_DRAIN_DEPTH = 25
export const HEARTBEAT_BUSY_RETRY_MS = 1_000
export const STALE_QUEUED_RUN_MS = 15_000
export const STUCK_RUN_THRESHOLD_MS = 20 * 60_000
export const SHARED_ACTIVITY_LEASE_OWNER = `session-run:${process.pid}:${genId(6)}`

export const state: SessionRunManagerState = hmrSingleton<SessionRunManagerState>(
  '__swarmclaw_session_run_manager__',
  () => ({
    runningByExecution: new Map<string, SessionRunQueueEntry>(),
    queueByExecution: new Map<string, SessionRunQueueEntry[]>(),
    runs: new Map<string, SessionRunRecord>(),
    recentRunIds: [],
    promises: new Map<string, Promise<import('@/lib/server/chat-execution/chat-execution').ExecuteChatTurnResult>>(),
    deferredDrainTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    activityLeaseRenewTimers: new Map<string, ReturnType<typeof setInterval>>(),
    externalSessionHolds: new Map<string, number>(),
    externalHoldTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    drainDepth: new Map<string, number>(),
    lastQueuedAt: 0,
    nonHeartbeatWorkCount: new Map<string, number>(),
  }),
)

export const recoveryState = hmrSingleton('__swarmclaw_session_run_recovery__', () => ({ completed: false }))

if (!state.runningByExecution) state.runningByExecution = new Map<string, SessionRunQueueEntry>()
if (!state.queueByExecution) state.queueByExecution = new Map<string, SessionRunQueueEntry[]>()
if (!state.runs) state.runs = new Map<string, SessionRunRecord>()
if (!state.recentRunIds) state.recentRunIds = []
if (!state.promises) {
  state.promises = new Map<string, Promise<import('@/lib/server/chat-execution/chat-execution').ExecuteChatTurnResult>>()
}
if (!state.deferredDrainTimers) state.deferredDrainTimers = new Map<string, ReturnType<typeof setTimeout>>()
if (!state.activityLeaseRenewTimers) state.activityLeaseRenewTimers = new Map<string, ReturnType<typeof setInterval>>()
if (!state.externalSessionHolds) state.externalSessionHolds = new Map<string, number>()
if (!state.externalHoldTimers) state.externalHoldTimers = new Map<string, ReturnType<typeof setTimeout>>()
if (!state.drainDepth) state.drainDepth = new Map<string, number>()
if (typeof state.lastQueuedAt !== 'number') state.lastQueuedAt = 0
if (!state.nonHeartbeatWorkCount) state.nonHeartbeatWorkCount = new Map<string, number>()

export function now() {
  return Date.now()
}

export function nextQueuedAt() {
  const current = now()
  const next = current <= state.lastQueuedAt ? state.lastQueuedAt + 1 : current
  state.lastQueuedAt = next
  return next
}

export function messagePreview(text: string): string {
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

export function syncRunRecord(run: SessionRunRecord): SessionRunRecord {
  state.runs.set(run.id, run)
  persistRun(run)
  return run
}

export function registerRun(run: SessionRunRecord) {
  syncRunRecord(run)
  state.recentRunIds.push(run.id)
  trimRecentRuns()
}

function shouldPersistRunEvent(event: SSEEvent): boolean {
  return event.t !== 'd' && event.t !== 'thinking' && event.t !== 'reset'
}

export function persistEventForRun(entry: SessionRunQueueEntry, event: SSEEvent, opts?: {
  phase?: RunEventRecord['phase']
  status?: SessionRunStatus
  summary?: string
}): void {
  if (!shouldPersistRunEvent(event)) return
  appendPersistedRunEvent({
    runId: entry.run.id,
    sessionId: entry.run.sessionId,
    kind: entry.run.kind,
    ownerType: entry.run.ownerType,
    ownerId: entry.run.ownerId,
    parentExecutionId: entry.run.parentExecutionId,
    phase: opts?.phase || 'event',
    status: opts?.status,
    summary: opts?.summary,
    event,
  })
}

export function chainCallerSignal(callerSignal: AbortSignal, controller: AbortController): void {
  if (callerSignal.aborted) {
    controller.abort()
    return
  }
  const onAbort = () => controller.abort()
  callerSignal.addEventListener('abort', onAbort, { once: true })
}

export function emitToSubscribers(entry: SessionRunQueueEntry, event: SSEEvent) {
  persistEventForRun(entry, event)
  for (const send of entry.onEvents) {
    try {
      send(event)
    } catch {
      // Subscriber stream can be closed by the client.
    }
  }
}

export function emitRunMeta(entry: SessionRunQueueEntry, status: SessionRunStatus, extra?: Record<string, unknown>) {
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

export function notifySessionRunState(sessionId: string): void {
  notify('runs')
  notify('sessions')
  notify(`session:${sessionId}`)
}

export function queueAutonomyObservation(input: {
  runId: string
  sessionId: string
  source: string
  status: SessionRunStatus
  resultText?: string | null
  error?: string | null
  toolEvents?: import('@/lib/server/chat-execution/chat-execution').ExecuteChatTurnResult['toolEvents']
  sourceMessage?: string | null
}) {
  const session = getSession(input.sessionId)
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

export function markRunningEntryCancelled(entry: SessionRunQueueEntry, reason: string) {
  if (entry.run.status === 'cancelled') return
  entry.run.status = 'cancelled'
  entry.run.endedAt = now()
  entry.run.error = reason
  syncRunRecord(entry.run)
  emitRunMeta(entry, 'cancelled', { reason })
}

export function abortSessionRuntime(entry: SessionRunQueueEntry, reason: string) {
  markRunningEntryCancelled(entry, reason)
  entry.signalController.abort()
  try { getActiveSessionProcess(entry.run.sessionId)?.kill?.() } catch { /* noop */ }
  stopActiveSessionProcess(entry.run.sessionId)
  try { cleanupSessionBrowser(entry.run.sessionId) } catch { /* noop */ }
  try { cancelDelegationJobsForParentSession(entry.run.sessionId, reason) } catch { /* noop */ }
}

export function executionKeyForSession(sessionId: string): string {
  return `session:${sessionId}`
}

export function nonHeartbeatActivityLeaseName(sessionId: string): string {
  return `session-non-heartbeat:${sessionId}`
}

export function hasActiveNonHeartbeatSessionLease(sessionId: string): boolean {
  return isRuntimeLockActive(nonHeartbeatActivityLeaseName(sessionId))
}

export function hasExternalSessionExecutionHold(sessionId: string): boolean {
  return (state.externalSessionHolds.get(sessionId) || 0) > 0
}

export function acquireExternalSessionExecutionHold(
  sessionId: string,
  onRelease: (executionKey: string) => void,
): () => void {
  const current = state.externalSessionHolds.get(sessionId) || 0
  state.externalSessionHolds.set(sessionId, current + 1)
  let released = false
  const holdKey = `${sessionId}:${current + 1}`
  const ttlTimer = setTimeout(() => {
    if (released) return
    log.warn('session-run', 'External hold auto-released after TTL', { sessionId, holdKey, ttlMs: EXTERNAL_HOLD_TTL_MS })
    release()
  }, EXTERNAL_HOLD_TTL_MS)
  state.externalHoldTimers.set(holdKey, ttlTimer)
  const release = () => {
    if (released) return
    released = true
    const timer = state.externalHoldTimers.get(holdKey)
    if (timer) {
      clearTimeout(timer)
      state.externalHoldTimers.delete(holdKey)
    }
    const next = (state.externalSessionHolds.get(sessionId) || 1) - 1
    if (next > 0) state.externalSessionHolds.set(sessionId, next)
    else state.externalSessionHolds.delete(sessionId)
    onRelease(executionKeyForSession(sessionId))
  }
  return release
}

export function queueForExecution(executionKey: string): SessionRunQueueEntry[] {
  const existing = state.queueByExecution.get(executionKey)
  if (existing) return existing
  const created: SessionRunQueueEntry[] = []
  state.queueByExecution.set(executionKey, created)
  return created
}

export function normalizeMode(mode: string | undefined, internal: boolean): SessionQueueMode {
  if (mode === 'steer' || mode === 'collect' || mode === 'followup') return mode
  return internal ? 'collect' : 'followup'
}

export function markPersistedRunInterrupted(run: SessionRunRecord, reason: string): SessionRunRecord {
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

function isNonHeartbeatEntry(entry: SessionRunQueueEntry): boolean {
  return !isInternalHeartbeatRun(entry.run.internal, entry.run.source)
}

export function incrementNonHeartbeatWork(entry: SessionRunQueueEntry): void {
  if (!isNonHeartbeatEntry(entry)) return
  entry.nonHeartbeatCounted = true
  state.nonHeartbeatWorkCount.set(entry.run.sessionId, (state.nonHeartbeatWorkCount.get(entry.run.sessionId) || 0) + 1)
}

export function decrementNonHeartbeatWork(entry: SessionRunQueueEntry): void {
  if (!entry.nonHeartbeatCounted) return
  entry.nonHeartbeatCounted = false
  const sessionId = entry.run.sessionId
  const count = (state.nonHeartbeatWorkCount.get(sessionId) || 0) - 1
  if (count <= 0) state.nonHeartbeatWorkCount.delete(sessionId)
  else state.nonHeartbeatWorkCount.set(sessionId, count)
}

export function hasLocalNonHeartbeatWork(sessionId: string): boolean {
  return (state.nonHeartbeatWorkCount.get(sessionId) || 0) > 0
}

export function clearDeferredDrain(executionKey: string): void {
  const timer = state.deferredDrainTimers.get(executionKey)
  if (!timer) return
  clearTimeout(timer)
  state.deferredDrainTimers.delete(executionKey)
}

export function deleteQueueEntry(queue: SessionRunQueueEntry[], target: SessionRunQueueEntry): boolean {
  const idx = queue.indexOf(target)
  if (idx === -1) return false
  queue.splice(idx, 1)
  return true
}

export function scheduleDeferredDrain(
  executionKey: string,
  onDrain: (executionKey: string) => void,
  delayMs = HEARTBEAT_BUSY_RETRY_MS,
): void {
  if (state.deferredDrainTimers.has(executionKey)) return
  const timer = setTimeout(() => {
    state.deferredDrainTimers.delete(executionKey)
    onDrain(executionKey)
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

export function reconcileSessionActivityLease(sessionId: string): void {
  if (hasLocalNonHeartbeatWork(sessionId)) startSessionActivityLease(sessionId)
  else stopSessionActivityLease(sessionId)
}

export function resetSessionRunManagerStateForTests(): void {
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
  for (const timer of state.externalHoldTimers.values()) clearTimeout(timer)
  state.externalHoldTimers.clear()
  state.nonHeartbeatWorkCount.clear()
  state.drainDepth.clear()
  state.lastQueuedAt = 0
}
