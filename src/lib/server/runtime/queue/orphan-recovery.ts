export const MAX_ORPHAN_RECOVERY_ATTEMPTS = 3

export type OrphanRecoveryDecision =
  | { action: 'recover'; attempt: number; firstAttempt: boolean }
  | { action: 'dead_letter'; attempt: number }

/**
 * Tracks how many times an orphaned queued task has been re-queued by the
 * startup/daemon recovery scan. Recovery is allowed a bounded number of
 * attempts; after that the task should be dead-lettered with one terminal
 * reason instead of looping through recovery forever.
 */
export function trackOrphanRecovery(
  attempts: Record<string, number>,
  taskId: string,
  max: number = MAX_ORPHAN_RECOVERY_ATTEMPTS,
): OrphanRecoveryDecision {
  const attempt = (attempts[taskId] || 0) + 1
  attempts[taskId] = attempt
  if (attempt > max) return { action: 'dead_letter', attempt }
  return { action: 'recover', attempt, firstAttempt: attempt === 1 }
}

/** Drops counters for tasks that are no longer orphaned so a future orphan starts fresh. */
export function pruneOrphanRecovery(
  attempts: Record<string, number>,
  stillOrphanedIds: ReadonlySet<string>,
): void {
  for (const taskId of Object.keys(attempts)) {
    if (!stillOrphanedIds.has(taskId)) delete attempts[taskId]
  }
}
