import { log } from '@/lib/server/logger'
import { errorMessage } from '@/lib/shared-utils'
import { isAllEstopEngaged, isAutonomyEstopEngaged } from '@/lib/server/runtime/estop'
import {
  isRestartRecoverableSource,
  listPersistedRuns,
  loadRecoverableStaleRuns,
} from '@/lib/server/runtime/run-ledger'

import {
  abortSessionRuntime,
  clearDeferredDrain,
  decrementNonHeartbeatWork,
  deleteQueueEntry,
  executionKeyForSession,
  markPersistedRunInterrupted,
  normalizeMode,
  now,
  reconcileSessionActivityLease,
  recoveryState,
  STALE_QUEUED_RUN_MS,
  state,
  syncRunRecord,
  STUCK_RUN_THRESHOLD_MS,
} from './state'
import type { EnqueueSessionRunInput, SessionRunQueueEntry } from './types'

type EnqueueSessionRunFn = (input: EnqueueSessionRunInput) => unknown
type DrainExecutionFn = (executionKey: string) => Promise<void>

function resolveRecoveredQueuedEntry(entry: SessionRunQueueEntry, reason: string): void {
  decrementNonHeartbeatWork(entry)
  if (entry.run.status === 'completed' || entry.run.status === 'failed' || entry.run.status === 'cancelled') {
    entry.run.endedAt = entry.run.endedAt || now()
  } else {
    entry.run.status = 'failed'
    entry.run.endedAt = now()
  }
  entry.run.error = reason
  syncRunRecord(entry.run)
  entry.onEvents.forEach((send) => {
    try {
      send({ t: 'err', text: reason })
    } catch {
      // Subscriber stream can be closed by the client.
    }
  })
  entry.resolve({
    runId: entry.run.id,
    sessionId: entry.run.sessionId,
    ...(entry.run.missionId ? { missionId: entry.run.missionId } : {}),
    text: '',
    persisted: false,
    toolEvents: [],
    error: reason,
  })
}

export function ensureRecoveredPersistedRuns(enqueueSessionRun: EnqueueSessionRunFn): void {
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

export function repairSessionRunQueue(
  sessionId: string,
  drainExecution: DrainExecutionFn,
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

export function sweepStuckRuns(enqueueSessionRun: EnqueueSessionRunFn): { aborted: number } {
  const deadline = now()
  let aborted = 0

  for (const [execKey, entry] of state.runningByExecution.entries()) {
    const age = deadline - (entry.run.startedAt || entry.run.queuedAt)
    if (entry.maxRuntimeMs && age < entry.maxRuntimeMs * 1.5) continue
    if (age < STUCK_RUN_THRESHOLD_MS) continue

    abortSessionRuntime(entry, 'Watchdog: run exceeded maximum allowed duration')
    state.runningByExecution.delete(execKey)
    decrementNonHeartbeatWork(entry)
    reconcileSessionActivityLease(entry.run.sessionId)
    aborted++
  }

  const persistedRunning = listPersistedRuns({ status: 'running' })
  for (const run of persistedRunning) {
    const execKey = run.recoveryPayload?.executionGroupKey || executionKeyForSession(run.sessionId)
    const inMemory = state.runningByExecution.get(execKey)
    if (inMemory && inMemory.run.id === run.id) continue

    const age = deadline - (run.startedAt || run.queuedAt)
    if (age < STUCK_RUN_THRESHOLD_MS) continue

    markPersistedRunInterrupted(run, 'Watchdog: orphaned run detected after server restart or HMR')
    aborted++

    const alreadyRunning = state.runningByExecution.has(execKey)
    const alreadyQueued = (state.queueByExecution.get(execKey) || []).some((entry) => entry.run.sessionId === run.sessionId)
    if (run.recoveryPayload && isRestartRecoverableSource(run.source) && !alreadyRunning && !alreadyQueued) {
      try {
        const payload = run.recoveryPayload
        enqueueSessionRun({
          sessionId: run.sessionId,
          message: payload.message,
          imagePath: payload.imagePath,
          imageUrl: payload.imageUrl,
          attachedFiles: payload.attachedFiles,
          internal: payload.internal,
          source: payload.source,
          mode: normalizeMode(payload.mode, payload.internal),
          dedupeKey: run.dedupeKey,
          maxRuntimeMs: payload.maxRuntimeMs,
          modelOverride: payload.modelOverride,
          heartbeatConfig: payload.heartbeatConfig,
          replyToId: payload.replyToId,
          executionGroupKey: payload.executionGroupKey,
          recoveredFromRestart: true,
          recoveredFromRunId: run.id,
        })
      } catch (err: unknown) {
        log.warn('session-run', `Watchdog: failed to re-enqueue orphaned run ${run.id}`, {
          sessionId: run.sessionId,
          error: errorMessage(err),
        })
      }
    }
  }

  return { aborted }
}
