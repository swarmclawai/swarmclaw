import { genId } from '@/lib/id'
import { NextResponse } from 'next/server'
import { loadAgents, loadSettings, loadTasks, logActivity, upsertStoredItems, upsertTask } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { disableSessionHeartbeat, enqueueTask, recoverStalledRunningTasks, validateCompletedTasksQueue } from '@/lib/server/queue'
import { ensureTaskCompletionReport } from '@/lib/server/task-reports'
import { formatValidationFailure, validateTaskCompletion } from '@/lib/server/task-validation'
import { pushMainLoopEventToMainSessions } from '@/lib/server/main-agent-loop'
import { notify } from '@/lib/server/ws-hub'
import { createNotification } from '@/lib/server/create-notification'
import { enqueueSystemEvent } from '@/lib/server/system-events'
import { requestHeartbeatNow } from '@/lib/server/heartbeat-wake'
import { validateDag, cascadeUnblock } from '@/lib/server/dag-validation'
import { getPluginManager } from '@/lib/server/plugins'
import { normalizeTaskQualityGate } from '@/lib/server/task-quality-gate'
import type { BoardTask } from '@/types'
import '@/lib/server/builtin-plugins'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Keep completed queue integrity even if daemon is not running.
  validateCompletedTasksQueue()
  recoverStalledRunningTasks()

  const { id } = await params
  const tasks = loadTasks()
  if (!tasks[id]) return notFound()
  return NextResponse.json(tasks[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const settings = loadSettings()
  const tasks = loadTasks()
  if (!tasks[id]) return notFound()

  const prevStatus = tasks[id].status

  // DAG validation: reject if proposed blockedBy would create a cycle
  if (Array.isArray(body.blockedBy)) {
    const dagResult = validateDag(tasks, id, body.blockedBy)
    if (!dagResult.valid) {
      return NextResponse.json(
        { error: 'Dependency cycle detected', cycle: dagResult.cycle },
        { status: 400 },
      )
    }
  }

  // Support atomic comment append to avoid race conditions
  if (body.appendComment) {
    if (!tasks[id].comments) tasks[id].comments = []
    tasks[id].comments.push(body.appendComment)
    tasks[id].updatedAt = Date.now()
  } else {
    if (Object.prototype.hasOwnProperty.call(body, 'qualityGate')) {
      body.qualityGate = body.qualityGate
        ? normalizeTaskQualityGate(body.qualityGate, settings)
        : null
    }
    Object.assign(tasks[id], body, { updatedAt: Date.now() })
    // Explicitly clear nullable fields when sent as null (Object.assign copies null but not undefined)
    if (body.projectId === null) delete tasks[id].projectId
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
    const validation = validateTaskCompletion(tasks[id], { report, settings })
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
        id: genId(),
        author: 'System',
        text: `Completion validation failed.\n\n${validation.reasons.map((r) => `- ${r}`).join('\n')}`,
        createdAt: Date.now(),
      })
    }
  }

  upsertTask(id, tasks[id])
  logActivity({ entityType: 'task', entityId: id, action: 'updated', actor: 'user', summary: `Task updated: "${tasks[id].title}" (${prevStatus} → ${tasks[id].status})` })
  if (prevStatus !== tasks[id].status) {
    pushMainLoopEventToMainSessions({
      type: 'task_status_changed',
      text: `Task "${tasks[id].title}" (${id}) moved ${prevStatus} → ${tasks[id].status}.`,
    })
  }

  // If task is manually transitioned to a terminal status, disable session heartbeat.
  if (prevStatus !== tasks[id].status && (tasks[id].status === 'completed' || tasks[id].status === 'failed')) {
    disableSessionHeartbeat(tasks[id].sessionId)
    createNotification({
      type: tasks[id].status === 'completed' ? 'success' : 'error',
      title: `Task ${tasks[id].status}: "${tasks[id].title}"`,
      message: tasks[id].status === 'failed' ? tasks[id].error?.slice(0, 200) : undefined,
      entityType: 'task',
      entityId: id,
    })
    
    if (tasks[id].status === 'completed') {
      const agentPlugins = tasks[id].agentId ? (loadAgents()[tasks[id].agentId]?.plugins || []) : []
      getPluginManager().runHook(
        'onTaskComplete',
        { taskId: id, result: tasks[id].result },
        { enabledIds: agentPlugins },
      )
    }

    // Enqueue system event + heartbeat wake
    if (tasks[id].sessionId) {
      enqueueSystemEvent(tasks[id].sessionId, `Task ${tasks[id].status}: ${tasks[id].title}`)
    }
    if (tasks[id].agentId) {
      requestHeartbeatNow({ agentId: tasks[id].agentId, reason: 'task-completed' })
    }
  }

  // Dependency check: cannot queue a task if any blocker is incomplete
  if (tasks[id].status === 'queued') {
    const blockers = Array.isArray(tasks[id].blockedBy) ? tasks[id].blockedBy : []
    const incompleteBlocker = blockers.find((bid: string) => tasks[bid] && tasks[bid].status !== 'completed')
    if (incompleteBlocker) {
      // Revert status change and reject
      tasks[id].status = prevStatus
      tasks[id].updatedAt = Date.now()
      upsertTask(id, tasks[id])
      return NextResponse.json(
        { error: 'Cannot queue: blocked by incomplete tasks', blockedBy: incompleteBlocker },
        { status: 409 },
      )
    }
  }

  // When a task is completed, cascade unblock dependent tasks
  if (tasks[id].status === 'completed') {
    const unblockedIds = cascadeUnblock(tasks, id)
    if (unblockedIds.length > 0) {
      upsertStoredItems('tasks', [
        [id, tasks[id]],
        ...unblockedIds.map((uid) => [uid, tasks[uid]] as [string, BoardTask]),
      ])
      for (const uid of unblockedIds) {
        enqueueTask(uid)
      }
    }
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
  if (!tasks[id]) return notFound()

  // Soft delete: move to archived status instead of hard delete
  tasks[id].status = 'archived'
  tasks[id].archivedAt = Date.now()
  tasks[id].updatedAt = Date.now()
  upsertTask(id, tasks[id])
  logActivity({ entityType: 'task', entityId: id, action: 'deleted', actor: 'user', summary: `Task archived: "${tasks[id].title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_archived',
    text: `Task archived: "${tasks[id].title}" (${id}).`,
  })

  notify('tasks')
  return NextResponse.json(tasks[id])
}
