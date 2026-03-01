import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadTasks, saveTasks, loadSettings, logActivity } from '@/lib/server/storage'
import { enqueueTask, validateCompletedTasksQueue } from '@/lib/server/queue'
import { ensureTaskCompletionReport } from '@/lib/server/task-reports'
import { formatValidationFailure, validateTaskCompletion } from '@/lib/server/task-validation'
import { pushMainLoopEventToMainSessions } from '@/lib/server/main-agent-loop'
import { notify } from '@/lib/server/ws-hub'

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

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') // 'all' | 'schedule' | 'done' | null
  const tasks = loadTasks()
  let removed = 0

  const shouldRemove = (task: { status: string; sourceType?: string }) =>
    filter === 'all' ||
    (filter === 'schedule' && task.sourceType === 'schedule') ||
    (filter === 'done' && (task.status === 'completed' || task.status === 'failed')) ||
    (!filter && task.status === 'archived')

  const { deleteTask } = await import('@/lib/server/storage')
  for (const [id, task] of Object.entries(tasks)) {
    if (shouldRemove(task as { status: string; sourceType?: string })) {
      deleteTask(id)
      removed++
    }
  }
  notify('tasks')
  return NextResponse.json({ removed, remaining: Object.keys(tasks).length - removed })
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = genId()
  const now = Date.now()
  const tasks = loadTasks()
  const settings = loadSettings()
  const maxAttempts = Number.isFinite(Number(body.maxAttempts))
    ? Math.max(1, Math.min(20, Math.trunc(Number(body.maxAttempts))))
    : Math.max(1, Math.min(20, Math.trunc(Number(settings.defaultTaskMaxAttempts ?? 3))))
  const retryBackoffSec = Number.isFinite(Number(body.retryBackoffSec))
    ? Math.max(1, Math.min(3600, Math.trunc(Number(body.retryBackoffSec))))
    : Math.max(1, Math.min(3600, Math.trunc(Number(settings.taskRetryBackoffSec ?? 30))))
  tasks[id] = {
    id,
    title: body.title || 'Untitled Task',
    description: body.description || '',
    status: body.status || 'backlog',
    agentId: body.agentId || '',
    goalContract: body.goalContract || null,
    cwd: typeof body.cwd === 'string' ? body.cwd : null,
    file: typeof body.file === 'string' ? body.file : null,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    result: typeof body.result === 'string' ? body.result : null,
    error: typeof body.error === 'string' ? body.error : null,
    createdAt: now,
    updatedAt: now,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    attempts: 0,
    maxAttempts,
    retryBackoffSec,
    retryScheduledAt: null,
    deadLetteredAt: null,
    checkpoint: null,
    blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.filter((s: unknown) => typeof s === 'string') : [],
    blocks: Array.isArray(body.blocks) ? body.blocks.filter((s: unknown) => typeof s === 'string') : [],
    tags: Array.isArray(body.tags) ? body.tags.filter((s: unknown) => typeof s === 'string') : [],
    dueAt: typeof body.dueAt === 'number' ? body.dueAt : null,
    customFields: body.customFields && typeof body.customFields === 'object' ? body.customFields : undefined,
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
  logActivity({ entityType: 'task', entityId: id, action: 'created', actor: 'user', summary: `Task created: "${tasks[id].title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_created',
    text: `Task created: "${tasks[id].title}" (${id}) with status ${tasks[id].status}.`,
  })
  if (tasks[id].status === 'queued') {
    enqueueTask(id)
  }
  notify('tasks')
  return NextResponse.json(tasks[id])
}
