import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { loadTasks, saveTasks } from '@/lib/server/storage'
import { disableSessionHeartbeat, enqueueTask, validateCompletedTasksQueue } from '@/lib/server/queue'
import { ensureTaskCompletionReport } from '@/lib/server/task-reports'
import { formatValidationFailure, validateTaskCompletion } from '@/lib/server/task-validation'
import { pushMainLoopEventToMainSessions } from '@/lib/server/main-agent-loop'
import { notify } from '@/lib/server/ws-hub'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Keep completed queue integrity even if daemon is not running.
  validateCompletedTasksQueue()

  const { id } = await params
  const tasks = loadTasks()
  if (!tasks[id]) return new NextResponse(null, { status: 404 })
  return NextResponse.json(tasks[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const tasks = loadTasks()
  if (!tasks[id]) return new NextResponse(null, { status: 404 })

  const prevStatus = tasks[id].status

  // Support atomic comment append to avoid race conditions
  if (body.appendComment) {
    if (!tasks[id].comments) tasks[id].comments = []
    tasks[id].comments.push(body.appendComment)
    tasks[id].updatedAt = Date.now()
  } else {
    Object.assign(tasks[id], body, { updatedAt: Date.now() })
  }
  tasks[id].id = id // prevent id overwrite

  // Set archivedAt when transitioning to archived
  if (prevStatus !== 'archived' && tasks[id].status === 'archived') {
    tasks[id].archivedAt = Date.now()
  }

  // Re-validate any completed task updates so "completed" always means actually done.
  if (tasks[id].status === 'completed') {
    const report = ensureTaskCompletionReport(tasks[id])
    if (report?.relativePath) tasks[id].completionReportPath = report.relativePath
    const validation = validateTaskCompletion(tasks[id], { report })
    tasks[id].validation = validation
    if (validation.ok) {
      tasks[id].completedAt = tasks[id].completedAt || Date.now()
      tasks[id].error = null
    } else {
      tasks[id].status = 'failed'
      tasks[id].completedAt = null
      tasks[id].error = formatValidationFailure(validation.reasons).slice(0, 500)
      if (!tasks[id].comments) tasks[id].comments = []
      tasks[id].comments.push({
        id: crypto.randomBytes(4).toString('hex'),
        author: 'System',
        text: `Completion validation failed.\n\n${validation.reasons.map((r) => `- ${r}`).join('\n')}`,
        createdAt: Date.now(),
      })
    }
  }

  saveTasks(tasks)
  if (prevStatus !== tasks[id].status) {
    pushMainLoopEventToMainSessions({
      type: 'task_status_changed',
      text: `Task "${tasks[id].title}" (${id}) moved ${prevStatus} → ${tasks[id].status}.`,
    })
  }

  // If task is manually transitioned to a terminal status, disable session heartbeat.
  if (prevStatus !== tasks[id].status && (tasks[id].status === 'completed' || tasks[id].status === 'failed')) {
    disableSessionHeartbeat(tasks[id].sessionId)
  }

  // If status changed to 'queued', enqueue it
  if (prevStatus !== 'queued' && tasks[id].status === 'queued') {
    enqueueTask(id)
  }

  notify('tasks')
  return NextResponse.json(tasks[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tasks = loadTasks()
  if (!tasks[id]) return new NextResponse(null, { status: 404 })

  // Soft delete: move to archived status instead of hard delete
  tasks[id].status = 'archived'
  tasks[id].archivedAt = Date.now()
  tasks[id].updatedAt = Date.now()
  saveTasks(tasks)
  pushMainLoopEventToMainSessions({
    type: 'task_archived',
    text: `Task archived: "${tasks[id].title}" (${id}).`,
  })

  notify('tasks')
  return NextResponse.json(tasks[id])
}
