import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadTasks, saveTasks } from '@/lib/server/storage'
import { enqueueTask, validateCompletedTasksQueue } from '@/lib/server/queue'
import { ensureTaskCompletionReport } from '@/lib/server/task-reports'
import { formatValidationFailure, validateTaskCompletion } from '@/lib/server/task-validation'
import { pushMainLoopEventToMainSessions } from '@/lib/server/main-agent-loop'

export async function GET(req: Request) {
  // Keep completed queue integrity even if daemon is not running.
  validateCompletedTasksQueue()

  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('includeArchived') === 'true'
  const allTasks = loadTasks()

  if (includeArchived) {
    return NextResponse.json(allTasks)
  }

  // Exclude archived tasks by default
  const filtered: Record<string, typeof allTasks[string]> = {}
  for (const [id, task] of Object.entries(allTasks)) {
    if (task.status !== 'archived') {
      filtered[id] = task
    }
  }
  return NextResponse.json(filtered)
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = crypto.randomBytes(4).toString('hex')
  const now = Date.now()
  const tasks = loadTasks()
  tasks[id] = {
    id,
    title: body.title || 'Untitled Task',
    description: body.description || '',
    status: body.status || 'backlog',
    agentId: body.agentId || '',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    result: typeof body.result === 'string' ? body.result : null,
    error: typeof body.error === 'string' ? body.error : null,
    createdAt: now,
    updatedAt: now,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
  }

  if (tasks[id].status === 'completed') {
    const report = ensureTaskCompletionReport(tasks[id])
    if (report?.relativePath) tasks[id].completionReportPath = report.relativePath
    const validation = validateTaskCompletion(tasks[id], { report })
    tasks[id].validation = validation
    if (validation.ok) {
      tasks[id].completedAt = Date.now()
      tasks[id].error = null
    } else {
      tasks[id].status = 'failed'
      tasks[id].completedAt = null
      tasks[id].error = formatValidationFailure(validation.reasons).slice(0, 500)
    }
  }

  saveTasks(tasks)
  pushMainLoopEventToMainSessions({
    type: 'task_created',
    text: `Task created: "${tasks[id].title}" (${id}) with status ${tasks[id].status}.`,
  })
  if (tasks[id].status === 'queued') {
    enqueueTask(id)
  }
  return NextResponse.json(tasks[id])
}
