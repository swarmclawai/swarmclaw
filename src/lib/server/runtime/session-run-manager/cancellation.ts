import { isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'

import {
  abortSessionRuntime,
  decrementNonHeartbeatWork,
  emitRunMeta,
  now,
  reconcileSessionActivityLease,
  state,
  syncRunRecord,
} from './state'
import type { SessionRunQueueEntry } from './types'

export function cancelPendingForSession(sessionId: string, reason: string): number {
  let cancelled = 0
  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: SessionRunQueueEntry[] = []
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
      decrementNonHeartbeatWork(entry)
      cancelled += 1
    }
    if (keep.length > 0) state.queueByExecution.set(key, keep)
    else state.queueByExecution.delete(key)
  }
  reconcileSessionActivityLease(sessionId)
  return cancelled
}

function cancelQueuedEntries(
  matcher: (entry: SessionRunQueueEntry) => boolean,
  reason: string,
): { cancelled: number; sessionIds: Set<string> } {
  let cancelled = 0
  const sessionIds = new Set<string>()
  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: SessionRunQueueEntry[] = []
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
      decrementNonHeartbeatWork(entry)
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
  let cancelledQueued = 0
  let abortedRunning = 0

  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: SessionRunQueueEntry[] = []
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
  state.nonHeartbeatWorkCount.clear()

  return { cancelledQueued, abortedRunning }
}

export function cancelQueuedRunById(runId: string, reason = 'Removed from queue'): boolean {
  const result = cancelQueuedEntries((entry) => entry.run.id === runId, reason)
  return result.cancelled > 0
}

export function cancelQueuedRunsForSession(sessionId: string, reason = 'Cleared queued messages'): number {
  const result = cancelQueuedEntries((entry) => entry.run.sessionId === sessionId, reason)
  return result.cancelled
}

export function cancelSessionRuns(sessionId: string, reason = 'Cancelled'): { cancelledQueued: number; cancelledRunning: boolean } {
  const running = Array.from(state.runningByExecution.values())
    .find((entry) => entry.run.sessionId === sessionId)
  let cancelledRunning = false
  if (running) {
    cancelledRunning = true
    abortSessionRuntime(running, reason)
    state.runningByExecution.delete(running.executionKey)
    decrementNonHeartbeatWork(running)
  }
  const cancelledQueued = cancelPendingForSession(sessionId, reason)
  reconcileSessionActivityLease(sessionId)
  return { cancelledQueued, cancelledRunning }
}
