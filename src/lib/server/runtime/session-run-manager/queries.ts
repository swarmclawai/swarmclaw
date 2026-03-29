import type {
  RunEventRecord,
  SessionQueueSnapshot,
  SessionQueuedTurn,
  SessionRunRecord,
  SessionRunStatus,
} from '@/types'
import {
  listPersistedRunEvents,
  listPersistedRuns,
  loadPersistedRun,
} from '@/lib/server/runtime/run-ledger'
import { isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'

import { state } from './state'
import type { SessionRunQueueEntry } from './types'

export function getSessionRunState(sessionId: string): {
  runningRunId?: string
  queueLength: number
} {
  const summary = getSessionExecutionState(sessionId)
  return {
    runningRunId: summary.runningRunId,
    queueLength: summary.queueLength,
  }
}

function visibleQueuedEntriesForSession(sessionId: string): SessionRunQueueEntry[] {
  return Array.from(state.queueByExecution.values())
    .flatMap((queue) => queue)
    .filter((entry) => entry.run.sessionId === sessionId && entry.run.internal !== true)
    .sort((left, right) => left.run.queuedAt - right.run.queuedAt)
}

function toQueuedTurn(entry: SessionRunQueueEntry, index: number): SessionQueuedTurn {
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

function toActiveTurn(entry: SessionRunQueueEntry): SessionQueuedTurn {
  return {
    ...toQueuedTurn(entry, 0),
    position: 0,
  }
}

function visibleActiveTurnForSession(sessionId: string): SessionQueuedTurn | null {
  const running = Array.from(state.runningByExecution.values())
    .find((entry) => entry.run.sessionId === sessionId && entry.run.status === 'running')
  if (!running || running.run.internal === true) return null
  return toActiveTurn(running)
}

export function getSessionQueueSnapshot(sessionId: string): SessionQueueSnapshot {
  const execution = getSessionExecutionState(sessionId)
  const visibleQueued = visibleQueuedEntriesForSession(sessionId)
  return {
    sessionId,
    activeRunId: execution.runningRunId || null,
    activeTurn: visibleActiveTurnForSession(sessionId),
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
  return state.runs.get(runId) || loadPersistedRun(runId)
}

export function listRuns(params?: {
  sessionId?: string
  status?: SessionRunStatus
  limit?: number
}): SessionRunRecord[] {
  return listPersistedRuns(params)
}

export function listRunEvents(runId: string, limit?: number): RunEventRecord[] {
  return listPersistedRunEvents(runId, limit)
}
