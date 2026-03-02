import { createHash } from 'crypto'
import type { BoardTask } from '@/types'

/** SHA-256 fingerprint from title + agentId, first 16 hex chars. */
export function computeTaskFingerprint(title: string, agentId: string): string {
  const input = `${title.trim().toLowerCase()}::${agentId}`
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

const TERMINAL_STATUSES = new Set(['completed', 'archived', 'failed'])

/** Find an existing non-terminal task with the same fingerprint. */
export function findDuplicateTask(
  tasks: Record<string, BoardTask>,
  candidate: { fingerprint: string },
): BoardTask | null {
  for (const task of Object.values(tasks)) {
    if (
      task.fingerprint === candidate.fingerprint &&
      !TERMINAL_STATUSES.has(task.status)
    ) {
      return task
    }
  }
  return null
}
