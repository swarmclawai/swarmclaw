import type { BoardTask } from '@/types'

interface DagResult {
  valid: boolean
  cycle?: string[]
}

/**
 * Validate that adding `proposedBlockedBy` to `taskId` would not create a cycle
 * in the task dependency graph. Uses DFS to check if `taskId` is reachable from
 * any of its proposed blockers (which would mean a cycle).
 */
export function validateDag(
  tasks: Record<string, BoardTask>,
  taskId: string,
  proposedBlockedBy: string[],
): DagResult {
  // Build adjacency: task -> tasks it is blocked by (its dependencies)
  // We temporarily add the proposed edges: taskId is blocked by proposedBlockedBy
  // A cycle exists if we can reach taskId by following blockedBy edges from any
  // of the proposed blockers.

  // DFS from each proposed blocker, following existing blockedBy edges.
  // If we reach taskId, we have a cycle.
  for (const startId of proposedBlockedBy) {
    if (startId === taskId) {
      return { valid: false, cycle: [taskId, taskId] }
    }

    const visited = new Set<string>()
    const path: string[] = []
    const found = dfs(tasks, startId, taskId, visited, path)
    if (found) {
      // path contains the route from startId to taskId
      // The full cycle is: taskId -> startId -> ... -> taskId
      return { valid: false, cycle: [taskId, ...path] }
    }
  }

  return { valid: true }
}

/**
 * DFS through the blockedBy graph starting from `current`, looking for `target`.
 * Returns true if target is found, and populates `path` with the route.
 */
function dfs(
  tasks: Record<string, BoardTask>,
  current: string,
  target: string,
  visited: Set<string>,
  path: string[],
): boolean {
  if (visited.has(current)) return false
  visited.add(current)
  path.push(current)

  const task = tasks[current]
  if (!task) {
    path.pop()
    return false
  }

  const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : []
  for (const blockerId of blockers) {
    if (blockerId === target) {
      path.push(blockerId)
      return true
    }
    if (dfs(tasks, blockerId, target, visited, path)) {
      return true
    }
  }

  path.pop()
  return false
}

/**
 * After a task completes, find all tasks that were blocked by it and check
 * if all their blockers are now done. If so, auto-queue them.
 * Returns the IDs of tasks that were unblocked.
 */
export function cascadeUnblock(
  tasks: Record<string, BoardTask>,
  completedTaskId: string,
): string[] {
  const completedTask = tasks[completedTaskId]
  if (!completedTask || completedTask.status !== 'completed') return []

  const unblocked: string[] = []
  const blockedIds = Array.isArray(completedTask.blocks) ? completedTask.blocks : []

  for (const blockedId of blockedIds) {
    const blocked = tasks[blockedId]
    if (!blocked) continue
    // Only auto-queue tasks that are in backlog (waiting on dependencies)
    if (blocked.status !== 'backlog') continue

    const deps = Array.isArray(blocked.blockedBy) ? blocked.blockedBy : []
    const allDone = deps.every((depId) => {
      const dep = tasks[depId]
      return dep?.status === 'completed'
    })

    if (allDone) {
      blocked.status = 'queued'
      blocked.queuedAt = Date.now()
      blocked.updatedAt = Date.now()
      unblocked.push(blockedId)
    }
  }

  return unblocked
}
