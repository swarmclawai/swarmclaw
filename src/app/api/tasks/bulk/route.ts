import { NextResponse } from 'next/server'
import { loadTasks, logActivity, upsertStoredItems } from '@/lib/server/storage'
import { enqueueTask, disableSessionHeartbeat } from '@/lib/server/queue'
import { pushMainLoopEventToMainSessions } from '@/lib/server/main-agent-loop'
import { notify } from '@/lib/server/ws-hub'
import { createNotification } from '@/lib/server/create-notification'
import type { BoardTask, BoardTaskStatus } from '@/types'

const VALID_STATUSES: BoardTaskStatus[] = ['backlog', 'queued', 'running', 'completed', 'failed', 'archived']

/**
 * Bulk update tasks — batch status changes, agent/project reassignment, or archive/delete.
 *
 * POST body:
 *   ids: string[]                — required, task IDs to update
 *   status?: BoardTaskStatus     — move all to this status
 *   agentId?: string | null      — reassign agent (null to clear)
 *   projectId?: string | null    — reassign project (null to clear)
 */
export async function POST(req: Request) {
  const body = await req.json()
  const ids: unknown = body.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }

  const taskIds = ids.filter((id): id is string => typeof id === 'string')
  if (taskIds.length === 0) {
    return NextResponse.json({ error: 'No valid task IDs provided' }, { status: 400 })
  }

  const tasks = loadTasks()
  let updated = 0
  const results: string[] = []

  for (const id of taskIds) {
    if (!tasks[id]) continue
    const prevStatus = tasks[id].status

    if (typeof body.status === 'string' && VALID_STATUSES.includes(body.status as BoardTaskStatus)) {
      tasks[id].status = body.status as BoardTaskStatus
      if (body.status === 'archived' && prevStatus !== 'archived') {
        tasks[id].archivedAt = Date.now()
      }
    }

    if ('agentId' in body) {
      tasks[id].agentId = body.agentId === null ? '' : String(body.agentId)
    }

    if ('projectId' in body) {
      if (body.projectId === null) {
        delete tasks[id].projectId
      } else {
        tasks[id].projectId = String(body.projectId)
      }
    }

    tasks[id].updatedAt = Date.now()
    updated++
    results.push(id)

    // Side-effects for status transitions
    if (prevStatus !== tasks[id].status) {
      logActivity({
        entityType: 'task',
        entityId: id,
        action: 'updated',
        actor: 'user',
        summary: `Bulk update: "${tasks[id].title}" (${prevStatus} → ${tasks[id].status})`,
      })
      pushMainLoopEventToMainSessions({
        type: 'task_status_changed',
        text: `Task "${tasks[id].title}" (${id}) moved ${prevStatus} → ${tasks[id].status}.`,
      })
      if (tasks[id].status === 'completed' || tasks[id].status === 'failed') {
        disableSessionHeartbeat(tasks[id].sessionId)
      }
      if (prevStatus !== 'queued' && tasks[id].status === 'queued') {
        enqueueTask(id)
      }
    }
  }

  upsertStoredItems('tasks', results.map((id) => [id, tasks[id]] as [string, BoardTask]))

  if (updated > 0) {
    const action = body.status
      ? `moved ${updated} task(s) to ${body.status}`
      : `updated ${updated} task(s)`
    createNotification({
      type: 'success',
      title: `Bulk update: ${action}`,
      entityType: 'task',
    })
  }

  notify('tasks')
  return NextResponse.json({ updated, ids: results })
}
