import { genId } from '@/lib/id'
import type { RunEventRecord, SessionRunRecord, SessionRunStatus, SSEEvent } from '@/types'
import {
  deleteRuntimeRun,
  deleteRuntimeRunEvent,
  loadRuntimeRun,
  loadRuntimeRunEvents,
  loadRuntimeRunEventsByRunId,
  loadRuntimeRuns,
  patchRuntimeRun,
  upsertRuntimeRun,
  upsertRuntimeRunEvent,
} from '@/lib/server/runtime/run-repository'

const MAX_SUMMARY_CHARS = 240
const RESTART_RECOVERABLE_SOURCES = new Set([
  'heartbeat',
  'heartbeat-wake',
  'schedule',
  'task',
  'delegation',
  'subagent',
])

function now(): number {
  return Date.now()
}

function summarizeEvent(event: SSEEvent): string | undefined {
  const raw = event.text || event.toolOutput || event.toolInput || event.toolName || ''
  if (!raw) return undefined
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS) || undefined
}

export function isRestartRecoverableSource(source: string): boolean {
  return RESTART_RECOVERABLE_SOURCES.has((source || '').trim().toLowerCase())
}

export function persistRun(run: SessionRunRecord): SessionRunRecord {
  upsertRuntimeRun(run.id, run)
  return run
}

export function patchPersistedRun(
  runId: string,
  updater: (current: SessionRunRecord | null) => SessionRunRecord | null,
): SessionRunRecord | null {
  return patchRuntimeRun(runId, updater)
}

export function loadPersistedRun(runId: string): SessionRunRecord | null {
  return loadRuntimeRun(runId)
}

export function listPersistedRuns(params?: {
  sessionId?: string
  status?: SessionRunStatus
  limit?: number
}): SessionRunRecord[] {
  const limit = Math.max(1, Math.min(1000, params?.limit ?? 200))
  return Object.values(loadRuntimeRuns())
    .filter((run) => (!params?.sessionId || run.sessionId === params.sessionId) && (!params?.status || run.status === params.status))
    .sort((left, right) => {
      const queuedDelta = (right.queuedAt || 0) - (left.queuedAt || 0)
      if (queuedDelta !== 0) return queuedDelta
      const rightTs = right.endedAt || right.startedAt || 0
      const leftTs = left.endedAt || left.startedAt || 0
      return rightTs - leftTs
    })
    .slice(0, limit)
}

export function appendPersistedRunEvent(input: {
  runId: string
  sessionId: string
  kind?: RunEventRecord['kind']
  ownerType?: RunEventRecord['ownerType']
  ownerId?: RunEventRecord['ownerId']
  parentExecutionId?: RunEventRecord['parentExecutionId']
  phase: 'status' | 'event'
  status?: SessionRunStatus
  event: SSEEvent
  timestamp?: number
  summary?: string
}): RunEventRecord {
  const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
    ? Math.trunc(input.timestamp)
    : now()
  const record: RunEventRecord = {
    id: genId(12),
    runId: input.runId,
    sessionId: input.sessionId,
    kind: input.kind,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    parentExecutionId: input.parentExecutionId,
    timestamp,
    phase: input.phase,
    status: input.status,
    summary: input.summary || summarizeEvent(input.event),
    event: input.event,
  }
  upsertRuntimeRunEvent(record.id, record)
  return record
}

export function listPersistedRunEvents(runId: string, limit = 1000): RunEventRecord[] {
  const safeLimit = Math.max(1, Math.min(5000, Math.trunc(limit)))
  // Query filtered at SQL level to avoid full-table scan
  const events = loadRuntimeRunEventsByRunId(runId)
  return events.slice(-safeLimit)
}

export function loadRecoverableStaleRuns(): SessionRunRecord[] {
  return Object.values(loadRuntimeRuns())
    .filter((run) => run.status === 'queued' || run.status === 'running')
    .sort((left, right) => left.queuedAt - right.queuedAt)
}

// ---------------------------------------------------------------------------
// Pruning — remove old terminal runs and their events to prevent unbounded growth.
// ---------------------------------------------------------------------------

const RUN_RETENTION_MS = 7 * 24 * 3600_000      // 7 days
const RUN_EVENT_RETENTION_MS = 3 * 24 * 3600_000 // 3 days

const TERMINAL_STATUSES = new Set<SessionRunStatus>(['completed', 'failed', 'cancelled'])

/** Orphaned non-terminal runs older than this are force-pruned (2× normal retention). */
const ORPHANED_RUN_RETENTION_MS = 2 * RUN_RETENTION_MS

export function pruneOldRuns(): { prunedRuns: number; prunedEvents: number } {
  const deadline = now()
  let prunedRuns = 0
  let prunedEvents = 0

  // Collect IDs of runs that are terminal and older than retention,
  // plus orphaned non-terminal runs that have been stuck for 2× retention
  const prunedRunIds = new Set<string>()
  const runs = loadRuntimeRuns()
  for (const [id, run] of Object.entries(runs)) {
    const endTs = run.endedAt || run.startedAt || run.queuedAt
    if (TERMINAL_STATUSES.has(run.status)) {
      if (deadline - endTs < RUN_RETENTION_MS) continue
    } else {
      // Non-terminal (running/queued) — only prune if stuck for much longer
      if (deadline - endTs < ORPHANED_RUN_RETENTION_MS) continue
    }
    deleteRuntimeRun(id)
    prunedRunIds.add(id)
    prunedRuns++
  }

  // Prune events for deleted runs, plus any orphaned old events
  const events = loadRuntimeRunEvents()
  for (const [id, event] of Object.entries(events)) {
    if (prunedRunIds.has(event.runId)) {
      deleteRuntimeRunEvent(id)
      prunedEvents++
      continue
    }
    // Also prune events for terminal runs older than event retention
    const parentRun = runs[event.runId]
    if (!parentRun || !TERMINAL_STATUSES.has(parentRun.status)) continue
    if (deadline - event.timestamp < RUN_EVENT_RETENTION_MS) continue
    deleteRuntimeRunEvent(id)
    prunedEvents++
  }

  return { prunedRuns, prunedEvents }
}
