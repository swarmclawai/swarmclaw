/**
 * WakeMode — explicit scheduling semantics for heartbeat and task execution.
 *
 * Replaces the implicit `source: 'heartbeat' | 'heartbeat-wake'` convention
 * with a formal enum that determines routing, priority, and isolation behavior.
 *
 * Inspired by OpenClaw's separation of "run now" vs "queue next heartbeat" vs
 * scheduled execution with proper isolation.
 */

// ── WakeMode enum ───────────────────────────────────────────────────────

export type WakeMode = 'immediate' | 'next_heartbeat' | 'scheduled'

/**
 * `immediate`       — Run now. Coalesced within a short window (250ms default),
 *                      then dispatched. Used for connector events, watch-job
 *                      triggers, approvals, webhooks.
 *
 * `next_heartbeat`  — Queue for the next periodic heartbeat tick. No coalesce
 *                      window; the job waits until the heartbeat-service timer
 *                      fires. Used for low-urgency background polling, system
 *                      events that don't need instant reaction.
 *
 * `scheduled`        — Run at a specific future time (absolute or relative).
 *                      Managed by the scheduler tick. Used for cron jobs,
 *                      interval schedules, one-shot delayed wakes.
 */

// ── Job Context ─────────────────────────────────────────────────────────

/**
 * Isolated execution context for a wake job. Each job gets its own context
 * so that failures, side effects, and state are contained.
 */
export interface JobContext {
  /** Unique job execution ID. */
  jobId: string
  /** Which session this job targets. */
  sessionId: string
  /** Which agent (if any) owns this job. */
  agentId?: string
  /** The wake mode that created this job. */
  mode: WakeMode
  /** When the job was created/requested. */
  createdAt: number
  /** When the job actually started executing. */
  startedAt?: number
  /** When the job finished (success or failure). */
  endedAt?: number
  /** Abort controller for this specific job. */
  signal: AbortSignal
  /** Source identifier (e.g. 'connector:slack', 'schedule:nightly'). */
  source?: string
  /** Human-readable reason for this wake. */
  reason?: string
  /** Snapshot of HEARTBEAT.md at job start (for isolation). */
  heartbeatSnapshot?: string
  /** Job-scoped metadata accumulator — tools can stash results here without
   *  polluting session state until the job completes successfully. */
  scratchpad: Map<string, unknown>
}

export function createJobContext(params: {
  jobId: string
  sessionId: string
  agentId?: string
  mode: WakeMode
  signal: AbortSignal
  source?: string
  reason?: string
  heartbeatSnapshot?: string
}): JobContext {
  return {
    jobId: params.jobId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    mode: params.mode,
    createdAt: Date.now(),
    signal: params.signal,
    source: params.source,
    reason: params.reason,
    heartbeatSnapshot: params.heartbeatSnapshot,
    scratchpad: new Map(),
  }
}

// ── Wake Request with explicit mode ─────────────────────────────────────

export interface WakeModeRequest {
  mode: WakeMode
  agentId?: string
  sessionId?: string
  reason?: string
  source?: string
  resumeMessage?: string
  detail?: string
  priority?: number
  /** For `scheduled` mode: absolute timestamp (ms) to execute at. */
  runAt?: number
  /** For `scheduled` mode: relative delay (ms) from now. */
  delayMs?: number
  /** Event ID for deduplication. */
  eventId?: string
}

// ── Priority mapping per mode ───────────────────────────────────────────

const MODE_BASE_PRIORITY: Record<WakeMode, number> = {
  immediate: 80,
  scheduled: 60,
  next_heartbeat: 40,
}

/**
 * Compute effective priority for a wake request. Explicit priority overrides
 * the mode-based default; otherwise the mode determines the base.
 */
export function computeWakePriority(request: WakeModeRequest): number {
  if (typeof request.priority === 'number' && Number.isFinite(request.priority)) {
    return Math.max(0, Math.min(100, Math.trunc(request.priority)))
  }
  return MODE_BASE_PRIORITY[request.mode]
}

/**
 * Resolve the target execution time for a wake request.
 * - `immediate`: now (or within coalesce window)
 * - `next_heartbeat`: null (deferred to next tick)
 * - `scheduled`: absolute time from runAt or now + delayMs
 */
export function resolveRunAt(request: WakeModeRequest, now = Date.now()): number | null {
  switch (request.mode) {
    case 'immediate':
      return now
    case 'next_heartbeat':
      return null
    case 'scheduled': {
      if (typeof request.runAt === 'number' && Number.isFinite(request.runAt)) {
        return Math.max(now, Math.trunc(request.runAt))
      }
      if (typeof request.delayMs === 'number' && Number.isFinite(request.delayMs)) {
        return now + Math.max(0, Math.trunc(request.delayMs))
      }
      return now
    }
  }
}

/**
 * Map a WakeMode to the session-run-manager source string.
 * Maintains backward compatibility with existing heartbeat-source checks.
 */
export function wakeModeToSource(mode: WakeMode): string {
  switch (mode) {
    case 'immediate':
      return 'heartbeat-wake'
    case 'next_heartbeat':
      return 'heartbeat'
    case 'scheduled':
      return 'heartbeat-wake'
  }
}

/**
 * Infer WakeMode from a legacy source string.
 * Used during migration to preserve backward compat with existing callers.
 */
export function sourceToWakeMode(source: string): WakeMode {
  if (source === 'heartbeat') return 'next_heartbeat'
  if (source === 'heartbeat-wake') return 'immediate'
  if (source.startsWith('schedule')) return 'scheduled'
  return 'immediate'
}
