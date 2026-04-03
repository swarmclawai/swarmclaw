import { NextResponse } from 'next/server'
import { validateA2ARequest } from '@/lib/a2a/auth'
import { loadTask } from '@/lib/server/tasks/task-repository'
import type { A2ATaskStatus } from '@/lib/a2a/types'
import type { BoardTaskStatus } from '@/types/task'

export const dynamic = 'force-dynamic'

function mapTaskStatus(status: BoardTaskStatus): A2ATaskStatus {
  switch (status) {
    case 'queued': case 'backlog': return 'submitted'
    case 'running': return 'working'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': case 'archived': case 'deferred': return 'cancelled'
    default: return 'submitted'
  }
}

/**
 * GET /api/a2a/tasks/:taskId/status
 *
 * Poll the status of an A2A task.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const auth = validateA2ARequest(req)
  if (!auth.valid) {
    return NextResponse.json({ error: auth.error }, { status: 401 })
  }

  const { taskId } = await params
  const task = loadTask(taskId)

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  return NextResponse.json({
    taskId: task.id,
    status: mapTaskStatus(task.status),
    title: task.title,
    result: task.status === 'completed' ? (task.result ?? null) : null,
    error: task.status === 'failed' ? (task.error ?? null) : null,
    updatedAt: task.updatedAt,
  })
}
