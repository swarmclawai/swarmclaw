import { loadSessions } from '@/lib/server/storage'
import type { Session } from '@/types'

const DEFAULT_IDLE_THRESHOLD_MS = 120_000 // 2 minutes
const DAILY_GUARANTEE_MS = 24 * 60 * 60 * 1000

type IdleCallback = () => void | Promise<void>

interface IdleWindowState {
  callbacks: IdleCallback[]
  lastDrainedAt: number
}

const state: IdleWindowState = {
  callbacks: [],
  lastDrainedAt: 0,
}

/**
 * Returns true when no user activity is detected recently
 * and no runs are currently executing.
 */
export function isIdleWindow(options?: { thresholdMs?: number }): boolean {
  const threshold = options?.thresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS
  const now = Date.now()
  const sessions = loadSessions()

  for (const session of Object.values(sessions) as unknown as Session[]) {
    if (!session?.id) continue
    const lastActive = session.lastActiveAt || 0
    if (lastActive > 0 && now - lastActive < threshold) return false
  }

  // Check for running runs via the session-run-manager (lazy import to avoid circular deps)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSessionExecutionState } = require('@/lib/server/runtime/session-run-manager')
    for (const session of Object.values(sessions) as unknown as Session[]) {
      if (!session?.id) continue
      const exec = getSessionExecutionState(session.id) as { runningRunId?: string }
      if (exec?.runningRunId) return false
    }
  } catch {
    // If session-run-manager isn't available, skip this check
  }

  return true
}

/**
 * Register a callback to run during the next idle window.
 * If no idle window occurs within 24h, the callback runs anyway (daily guarantee).
 */
export function onNextIdleWindow(callback: IdleCallback): void {
  state.callbacks.push(callback)
}

/**
 * Called from the daemon health check interval.
 * Drains queued callbacks when the system is idle,
 * or forces drain if the daily guarantee has elapsed.
 */
export async function drainIdleWindowCallbacks(): Promise<void> {
  if (state.callbacks.length === 0) return

  const now = Date.now()
  const forceDrain = now - state.lastDrainedAt >= DAILY_GUARANTEE_MS
  if (!forceDrain && !isIdleWindow()) return

  const batch = state.callbacks.splice(0)
  state.lastDrainedAt = now

  for (const cb of batch) {
    try {
      await cb()
    } catch (err) {
      console.warn('[idle-window] Callback failed:', err instanceof Error ? err.message : String(err))
    }
  }
}

/** Returns the number of pending callbacks (for diagnostics). */
export function pendingIdleCallbackCount(): number {
  return state.callbacks.length
}
