import {
  acquireExternalSessionExecutionHold as acquireExternalSessionExecutionHoldInternal,
  hasActiveNonHeartbeatSessionLease,
  resetSessionRunManagerStateForTests,
} from '@/lib/server/runtime/session-run-manager/state'
import {
  cancelAllHeartbeatRuns as cancelAllHeartbeatRunsInternal,
  cancelAllRuns as cancelAllRunsInternal,
  cancelQueuedRunById as cancelQueuedRunByIdInternal,
  cancelQueuedRunsForSession as cancelQueuedRunsForSessionInternal,
  cancelSessionRuns as cancelSessionRunsInternal,
} from '@/lib/server/runtime/session-run-manager/cancellation'
import { drainExecution as drainExecutionInternal } from '@/lib/server/runtime/session-run-manager/drain'
import { enqueueSessionRun as enqueueSessionRunInternal } from '@/lib/server/runtime/session-run-manager/enqueue'
import {
  getRunById as getRunByIdInternal,
  getSessionExecutionState as getSessionExecutionStateInternal,
  getSessionQueueSnapshot as getSessionQueueSnapshotInternal,
  getSessionRunState as getSessionRunStateInternal,
  listRunEvents as listRunEventsInternal,
  listRuns as listRunsInternal,
} from '@/lib/server/runtime/session-run-manager/queries'
import {
  ensureRecoveredPersistedRuns as ensureRecoveredPersistedRunsInternal,
  repairSessionRunQueue as repairSessionRunQueueInternal,
  sweepStuckRuns as sweepStuckRunsInternal,
} from '@/lib/server/runtime/session-run-manager/recovery'
import type {
  EnqueueSessionRunInput,
  EnqueueSessionRunResult,
} from '@/lib/server/runtime/session-run-manager/types'

export type {
  EnqueueSessionRunInput,
  EnqueueSessionRunResult,
  SessionQueueMode,
} from '@/lib/server/runtime/session-run-manager/types'

function ensureRecoveredPersistedRuns(): void {
  ensureRecoveredPersistedRunsInternal(enqueueSessionRun)
}

function drainExecution(executionKey: string): Promise<void> {
  return drainExecutionInternal(executionKey, { enqueueSessionRun })
}

export function acquireExternalSessionExecutionHold(sessionId: string): () => void {
  return acquireExternalSessionExecutionHoldInternal(sessionId, (executionKey) => {
    void drainExecution(executionKey)
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
  return repairSessionRunQueueInternal(sessionId, drainExecution, opts)
}

export function enqueueSessionRun(input: EnqueueSessionRunInput): EnqueueSessionRunResult {
  ensureRecoveredPersistedRuns()
  return enqueueSessionRunInternal(input, {
    repairSessionRunQueue: (sessionId, opts) => repairSessionRunQueue(sessionId, opts),
    drainExecution,
  })
}

export function getSessionRunState(sessionId: string) {
  ensureRecoveredPersistedRuns()
  return getSessionRunStateInternal(sessionId)
}

export function getSessionQueueSnapshot(sessionId: string) {
  ensureRecoveredPersistedRuns()
  return getSessionQueueSnapshotInternal(sessionId)
}

export function getSessionExecutionState(sessionId: string) {
  ensureRecoveredPersistedRuns()
  return getSessionExecutionStateInternal(sessionId)
}

export function getRunById(runId: string) {
  ensureRecoveredPersistedRuns()
  return getRunByIdInternal(runId)
}

export function listRuns(params?: Parameters<typeof listRunsInternal>[0]) {
  ensureRecoveredPersistedRuns()
  return listRunsInternal(params)
}

export function listRunEvents(runId: string, limit?: number) {
  ensureRecoveredPersistedRuns()
  return listRunEventsInternal(runId, limit)
}

export function cancelQueuedRunById(runId: string, reason = 'Removed from queue'): boolean {
  ensureRecoveredPersistedRuns()
  return cancelQueuedRunByIdInternal(runId, reason)
}

export function cancelQueuedRunsForSession(sessionId: string, reason = 'Cleared queued messages'): number {
  ensureRecoveredPersistedRuns()
  return cancelQueuedRunsForSessionInternal(sessionId, reason)
}

export function cancelSessionRuns(sessionId: string, reason = 'Cancelled') {
  ensureRecoveredPersistedRuns()
  return cancelSessionRunsInternal(sessionId, reason)
}

export function cancelAllHeartbeatRuns(reason = 'Heartbeat disabled globally') {
  ensureRecoveredPersistedRuns()
  return cancelAllHeartbeatRunsInternal(reason)
}

export function cancelAllRuns(reason = 'Cancelled') {
  ensureRecoveredPersistedRuns()
  return cancelAllRunsInternal(reason)
}

export function sweepStuckRuns(): { aborted: number } {
  ensureRecoveredPersistedRuns()
  return sweepStuckRunsInternal(enqueueSessionRun)
}

export function resetSessionRunManagerForTests(): void {
  resetSessionRunManagerStateForTests()
}

export { hasActiveNonHeartbeatSessionLease }
