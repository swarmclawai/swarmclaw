import { genId } from '@/lib/id'
import { loadTasks, saveTasks } from '@/lib/server/tasks/task-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import type { BoardTask } from '@/types/task'

interface SwarmDockTask {
  id: string
  requesterId: string
  title: string
  description: string
  skillRequirements: string[]
  budgetMax: string
  deadline: string | null
}

/**
 * Create a SwarmClaw BoardTask from a SwarmDock task assignment.
 * Uses `externalSource` to link back to the SwarmDock task (same pattern as GitHub issue import).
 */
export async function createBoardTaskFromAssignment(
  task: SwarmDockTask,
  agentId: string,
  connectorId: string,
  apiUrl: string,
): Promise<string> {
  const tasks = loadTasks() as Record<string, BoardTask>
  const id = genId()
  const now = Date.now()

  const boardTask: BoardTask = {
    id,
    title: task.title,
    description: task.description,
    status: 'running',
    agentId,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    lastActivityAt: now,
    sourceType: 'import',
    externalSource: {
      source: 'swarmdock',
      id: task.id,
      state: 'in_progress',
      url: `${apiUrl}/tasks/${task.id}`,
    },
    tags: task.skillRequirements,
    objective: task.description,
    followupConnectorId: connectorId,
  }

  if (task.deadline) {
    boardTask.dueAt = new Date(task.deadline).getTime()
  }

  tasks[id] = boardTask
  saveTasks(tasks)

  logActivity({
    entityType: 'task',
    entityId: id,
    action: 'created',
    actor: 'system',
    summary: `SwarmDock task assigned: "${task.title}"`,
  })

  return id
}

/**
 * Update a SwarmClaw BoardTask based on a SwarmDock SSE event.
 */
export async function updateBoardTaskFromEvent(
  swarmdockTaskId: string,
  eventType: string,
): Promise<void> {
  const tasks = loadTasks() as Record<string, BoardTask>
  const boardTask = Object.values(tasks).find(
    (t) => t.externalSource?.source === 'swarmdock' && t.externalSource.id === swarmdockTaskId,
  )
  if (!boardTask) return

  const now = Date.now()

  switch (eventType) {
    case 'task.completed':
      boardTask.status = 'completed'
      boardTask.completedAt = now
      boardTask.checkoutRunId = null
      break
    case 'task.submitted':
      // Results submitted, waiting for approval on SwarmDock
      if (boardTask.externalSource) boardTask.externalSource.state = 'review'
      break
    case 'task.cancelled':
      boardTask.status = 'cancelled'
      boardTask.checkoutRunId = null
      break
    case 'task.failed':
      boardTask.status = 'failed'
      boardTask.checkoutRunId = null
      break
  }

  boardTask.updatedAt = now
  boardTask.lastActivityAt = now
  saveTasks(tasks)
}

/**
 * Find a SwarmClaw BoardTask ID by its SwarmDock task ID.
 */
export function findBoardTaskBySwarmdockId(swarmdockTaskId: string): string | null {
  const tasks = loadTasks() as Record<string, BoardTask>
  const task = Object.values(tasks).find(
    (t) => t.externalSource?.source === 'swarmdock' && t.externalSource.id === swarmdockTaskId,
  )
  return task?.id || null
}
