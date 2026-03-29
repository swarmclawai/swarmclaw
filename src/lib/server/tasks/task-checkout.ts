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
    if (task.checkoutRunId) return null // already checked out

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
