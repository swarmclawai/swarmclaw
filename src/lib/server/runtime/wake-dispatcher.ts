/**
 * Wake Dispatcher — central routing for wake requests by WakeMode.
 *
 * Instead of callers directly choosing between `requestHeartbeatNow()` (immediate)
 * and the heartbeat-service timer (deferred), they call `dispatchWake()` with an
 * explicit WakeMode. The dispatcher routes to the correct execution path.
 *
 * This replaces the pattern where scheduler.ts both creates a task AND calls
 * requestHeartbeatNow() — the dispatcher handles that routing centrally.
 */

import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import type { WakeModeRequest, JobContext } from '@/lib/server/runtime/wake-mode'
import {
  computeWakePriority,
  resolveRunAt,
  wakeModeToSource,
  createJobContext,
} from '@/lib/server/runtime/wake-mode'
import type { WakeRequestInput } from '@/lib/server/runtime/heartbeat-wake'
import { requestHeartbeatNow } from '@/lib/server/runtime/heartbeat-wake'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'

// ── Deferred queue for `next_heartbeat` mode ────────────────────────────

interface DeferredWake {
  request: WakeModeRequest
  priority: number
  enqueuedAt: number
}

const state = hmrSingleton('__swarmclaw_wake_dispatcher__', () => ({
  deferredQueue: new Map<string, DeferredWake[]>(),
  scheduledTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  activeJobs: new Map<string, JobContext>(),
}))

function deferredKey(request: WakeModeRequest): string {
  return `${request.agentId || ''}::${request.sessionId || ''}`
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Dispatch a wake request through the appropriate execution path.
 *
 * - `immediate`: forwards to requestHeartbeatNow with coalesce
 * - `next_heartbeat`: queues for the next heartbeat-service tick to drain
 * - `scheduled`: sets a timer to fire requestHeartbeatNow at the target time
 */
export function dispatchWake(request: WakeModeRequest): {
  mode: string
  priority: number
  runAt: number | null
  jobId: string
} {
  const priority = computeWakePriority(request)
  const runAt = resolveRunAt(request)
  const jobId = genId(8)

  switch (request.mode) {
    case 'immediate':
      dispatchImmediate(request, priority, jobId)
      break
    case 'next_heartbeat':
      dispatchDeferred(request, priority, jobId)
      break
    case 'scheduled':
      dispatchScheduled(request, priority, runAt, jobId)
      break
  }

  return { mode: request.mode, priority, runAt, jobId }
}

function dispatchImmediate(request: WakeModeRequest, priority: number, jobId: string): void {
  const wakeInput: WakeRequestInput = {
    eventId: request.eventId || jobId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    reason: request.reason || 'immediate-wake',
    source: request.source,
    resumeMessage: request.resumeMessage,
    detail: request.detail,
    priority,
  }
  requestHeartbeatNow(wakeInput)
  log.info('wake-dispatcher', `Dispatched immediate wake ${jobId}`, {
    agentId: request.agentId,
    sessionId: request.sessionId,
    reason: request.reason,
    priority,
  })
}

function dispatchDeferred(request: WakeModeRequest, priority: number, jobId: string): void {
  const key = deferredKey(request)
  const queue = state.deferredQueue.get(key) || []

  // Deduplicate by eventId or reason+source
  const existingIndex = queue.findIndex((entry: any) => {
    if (request.eventId && entry.request.eventId) {
      return request.eventId === entry.request.eventId
    }
    return entry.request.reason === request.reason
      && entry.request.source === request.source
  })

  const entry: DeferredWake = { request, priority, enqueuedAt: Date.now() }

  if (existingIndex >= 0) {
    // Replace with higher-priority version
    if (priority >= queue[existingIndex].priority) {
      queue[existingIndex] = entry
    }
  } else {
    queue.push(entry)
  }

  // Keep sorted by priority (highest first)
  queue.sort((a: any, b: any) => b.priority - a.priority)
  state.deferredQueue.set(key, queue)

  log.info('wake-dispatcher', `Deferred wake ${jobId} queued for next heartbeat`, {
    agentId: request.agentId,
    sessionId: request.sessionId,
    reason: request.reason,
    queueDepth: queue.length,
  })
}

function dispatchScheduled(
  request: WakeModeRequest,
  priority: number,
  runAt: number | null,
  jobId: string,
): void {
  const now = Date.now()
  const targetTime = runAt ?? now
  const delayMs = Math.max(0, targetTime - now)

  // If the target time is now or in the past, dispatch immediately
  if (delayMs <= 0) {
    dispatchImmediate(request, priority, jobId)
    return
  }

  // Set a timer to fire at the target time
  const timerId = setTimeout(() => {
    state.scheduledTimers.delete(jobId)
    try {
      dispatchImmediate(request, priority, jobId)
    } catch (err: unknown) {
      log.error('wake-dispatcher', `Scheduled wake ${jobId} failed, retrying once`, {
        error: errorMessage(err),
        agentId: request.agentId,
        sessionId: request.sessionId,
      })
      // Single retry after 5s — if this also fails, the wake is lost (logged above)
      setTimeout(() => {
        try { dispatchImmediate(request, priority, jobId) } catch { /* give up */ }
      }, 5000)
    }
    log.info('wake-dispatcher', `Scheduled wake ${jobId} fired after ${delayMs}ms delay`, {
      agentId: request.agentId,
      sessionId: request.sessionId,
      reason: request.reason,
    })
  }, delayMs)

  state.scheduledTimers.set(jobId, timerId)

  log.info('wake-dispatcher', `Scheduled wake ${jobId} for ${new Date(targetTime).toISOString()}`, {
    agentId: request.agentId,
    sessionId: request.sessionId,
    reason: request.reason,
    delayMs,
  })

  // Also enqueue a system event so the agent knows something is scheduled
  if (request.sessionId && request.resumeMessage) {
    enqueueSystemEvent(
      request.sessionId,
      `[Scheduled] ${request.resumeMessage} (fires at ${new Date(targetTime).toISOString()})`,
    )
  }
}

// ── Deferred queue drain (called by heartbeat-service on each tick) ─────

/**
 * Drain all deferred wakes for a given session/agent. Called by heartbeat-service
 * during its periodic tick to pick up `next_heartbeat` mode requests.
 *
 * Returns the deferred events so the heartbeat-service can include them in
 * the prompt context alongside normal heartbeat content.
 */
export function drainDeferredWakes(agentId?: string, sessionId?: string): WakeModeRequest[] {
  const key = `${agentId || ''}::${sessionId || ''}`
  const queue = state.deferredQueue.get(key)
  if (!queue || queue.length === 0) return []

  const drained = queue.map((entry: any) => entry.request)
  state.deferredQueue.delete(key)

  log.info('wake-dispatcher', `Drained ${drained.length} deferred wakes`, {
    agentId,
    sessionId,
    reasons: drained.map((r: any) => r.reason),
  })

  return drained
}

/**
 * Check if there are pending deferred wakes for a target.
 */
export function hasDeferredWakes(agentId?: string, sessionId?: string): boolean {
  const key = `${agentId || ''}::${sessionId || ''}`
  const queue = state.deferredQueue.get(key)
  return !!queue && queue.length > 0
}

// ── Job context management ──────────────────────────────────────────────

/**
 * Create and register an isolated job context for a wake execution.
 * The job context provides per-job scratchpad, abort signal, and
 * heartbeat snapshot isolation.
 */
export function startJobExecution(params: {
  sessionId: string
  agentId?: string
  mode: WakeModeRequest['mode']
  signal: AbortSignal
  source?: string
  reason?: string
  heartbeatSnapshot?: string
}): JobContext {
  const jobId = genId(8)
  const ctx = createJobContext({
    jobId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    mode: params.mode,
    signal: params.signal,
    source: params.source,
    reason: params.reason,
    heartbeatSnapshot: params.heartbeatSnapshot,
  })
  ctx.startedAt = Date.now()
  state.activeJobs.set(jobId, ctx)
  return ctx
}

/**
 * Mark a job as completed and remove from active tracking.
 */
export function endJobExecution(jobId: string): JobContext | null {
  const ctx = state.activeJobs.get(jobId)
  if (!ctx) return null
  ctx.endedAt = Date.now()
  state.activeJobs.delete(jobId)
  return ctx
}

/**
 * Get the active job context by ID.
 */
export function getActiveJob(jobId: string): JobContext | null {
  return state.activeJobs.get(jobId) || null
}

/**
 * List all active job contexts for a session.
 */
export function getActiveJobsForSession(sessionId: string): JobContext[] {
  return [...state.activeJobs.values()].filter((ctx) => ctx.sessionId === sessionId)
}

// ── Cleanup ─────────────────────────────────────────────────────────────

export function cancelScheduledWake(jobId: string): boolean {
  const timer = state.scheduledTimers.get(jobId)
  if (!timer) return false
  clearTimeout(timer)
  state.scheduledTimers.delete(jobId)
  return true
}

export function resetWakeDispatcherForTests(): void {
  for (const timer of state.scheduledTimers.values()) {
    clearTimeout(timer)
  }
  state.deferredQueue.clear()
  state.scheduledTimers.clear()
  state.activeJobs.clear()
}

// ── Diagnostics ─────────────────────────────────────────────────────────

export function getWakeDispatcherStatus(): {
  deferredQueueCount: number
  scheduledTimerCount: number
  activeJobCount: number
} {
  let deferredCount = 0
  for (const queue of state.deferredQueue.values()) {
    deferredCount += queue.length
  }
  return {
    deferredQueueCount: deferredCount,
    scheduledTimerCount: state.scheduledTimers.size,
    activeJobCount: state.activeJobs.size,
  }
}
