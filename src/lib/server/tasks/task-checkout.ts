import type { BoardTask } from '@/types'
import { withTransaction } from '@/lib/server/persistence/transaction'
import { loadTasks, saveTasks } from '@/lib/server/tasks/task-repository'

/**
 * Atomically transition a task from queued → running with a checkout run ID.
 *
 * Uses a SQLite IMMEDIATE transaction to prevent two runners from starting the
 * same task concurrently (Paperclip-inspired atomic checkout pattern).
 *
 * Returns the checked-out task on success, or null if the task was already
 * taken, missing, or no longer in queued status.
 */
export function checkoutTask(
  taskId: string,
  runId: string,
): BoardTask | null {
  return withTransaction(() => {
    const tasks = loadTasks() as Record<string, BoardTask>
    const task = tasks[taskId]
    if (!task || task.status !== 'queued') return null
    // A stale checkoutRunId can survive an ungraceful server exit (crash,
    // SIGKILL, HMR reload mid-turn). If status is 'queued', the runId cannot
    // reference a live checkout — only running tasks hold active checkouts —
    // so treat the lingering id as stale and reclaim it. Previously this
    // returned null forever, so the dispatch → orphan-recovery → failed-
    // checkout cycle spammed "Recovering orphaned queued task" every ~2 ms
    // (21 k log lines in a single session).

    const now = Date.now()
    task.status = 'running'
    task.checkoutRunId = runId
    task.startedAt = now
    task.lastActivityAt = now
    task.retryScheduledAt = null
    task.deadLetteredAt = null
    task.error = null
    task.validation = null
    task.updatedAt = now

    saveTasks(tasks)
    return { ...task }
  })
}

/**
 * Release a checkout after task completion or failure.
 * Only the holder of the checkout (matching runId) can release it.
 */
export function releaseCheckout(
  taskId: string,
  runId: string,
): boolean {
  return withTransaction(() => {
    const tasks = loadTasks() as Record<string, BoardTask>
    const task = tasks[taskId]
    if (!task) return false
    if (task.checkoutRunId !== runId) return false

    task.checkoutRunId = null
    task.updatedAt = Date.now()
    saveTasks(tasks)
    return true
  })
}
