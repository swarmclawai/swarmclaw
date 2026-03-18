import { genId } from '@/lib/id'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import { createNotification } from '@/lib/server/create-notification'
import { validateDag, cascadeUnblock } from '@/lib/server/dag-validation'
import { getExtensionManager } from '@/lib/server/extensions'
import {
  enrichTaskWithMissionSummary,
  ensureMissionForTask,
  noteMissionTaskFinished,
} from '@/lib/server/missions/mission-service'
import {
  disableSessionHeartbeat,
  enqueueTask,
  recoverStalledRunningTasks,
  validateCompletedTasksQueue,
} from '@/lib/server/runtime/queue'
import { dispatchWake } from '@/lib/server/runtime/wake-dispatcher'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import {
  deleteTask,
  loadTask,
  loadTasks,
  saveTask,
  saveTaskMany,
} from '@/lib/server/tasks/task-repository'
import { resolveTaskAgentFromDescription } from '@/lib/server/tasks/task-mention'
import { applyTaskPatch, prepareTaskCreation } from '@/lib/server/tasks/task-service'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { notify } from '@/lib/server/ws-hub'
import type { BoardTask, BoardTaskStatus, TaskComment } from '@/types'

import '@/lib/server/builtin-extensions'

const VALID_BULK_STATUSES: BoardTaskStatus[] = ['backlog', 'queued', 'running', 'completed', 'failed', 'archived']

function normalizeTaskCommentInput(value: unknown): TaskComment | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      id: genId(),
      author: 'user',
      text: value.trim(),
      createdAt: Date.now(),
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const text = typeof row.text === 'string' ? row.text.trim() : ''
  if (!text) return null
  return {
    id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : genId(),
    author: typeof row.author === 'string' && row.author.trim() ? row.author.trim() : 'user',
    agentId: typeof row.agentId === 'string' && row.agentId.trim() ? row.agentId.trim() : undefined,
    text,
    createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
  }
}

export function prepareTasksForListing() {
  validateCompletedTasksQueue()
  recoverStalledRunningTasks()
  const allTasks = loadTasks()
  return Object.fromEntries(
    Object.entries(allTasks).map(([id, task]) => [id, enrichTaskWithMissionSummary(task)]),
  )
}

export function updateTaskFromRoute(id: string, body: Record<string, unknown>) {
  const settings = loadSettings()
  const tasks = loadTasks()
  if (!tasks[id]) return { ok: false as const, status: 404 as const }

  const prevStatus = tasks[id].status
  if (Array.isArray(body.blockedBy)) {
    const dagResult = validateDag(tasks, id, body.blockedBy)
    if (!dagResult.valid) {
      return {
        ok: false as const,
        status: 400 as const,
        payload: { error: 'Dependency cycle detected', cycle: dagResult.cycle },
      }
    }
  }

  if (body.appendComment) {
    const appendedComment = normalizeTaskCommentInput(body.appendComment)
    if (!appendedComment) {
      return {
        ok: false as const,
        status: 400 as const,
        payload: { error: 'Invalid task comment payload' },
      }
    }
    if (!tasks[id].comments) tasks[id].comments = []
    tasks[id].comments.push(appendedComment)
    tasks[id].updatedAt = Date.now()
  } else {
    applyTaskPatch({
      task: tasks[id],
      patch: body,
      now: Date.now(),
      settings,
      preserveCompletedAt: true,
      clearProjectIdWhenNull: true,
      invalidCompletionCommentAuthor: 'System',
    })
  }
  tasks[id].id = id

  if (typeof body.parentTaskId === 'string' || body.parentTaskId === null) {
    const oldParentId = tasks[id].parentTaskId
    const newParentId = typeof body.parentTaskId === 'string' && body.parentTaskId.trim() ? body.parentTaskId.trim() : null
    if (oldParentId && oldParentId !== newParentId && tasks[oldParentId]) {
      const oldSubs = Array.isArray(tasks[oldParentId].subtaskIds) ? tasks[oldParentId].subtaskIds : []
      tasks[oldParentId].subtaskIds = oldSubs.filter((s: string) => s !== id)
      tasks[oldParentId].updatedAt = Date.now()
      saveTask(oldParentId, tasks[oldParentId])
    }
    if (newParentId && tasks[newParentId]) {
      const newSubs = Array.isArray(tasks[newParentId].subtaskIds) ? tasks[newParentId].subtaskIds : []
      if (!newSubs.includes(id)) {
        tasks[newParentId].subtaskIds = [...newSubs, id]
        tasks[newParentId].updatedAt = Date.now()
        saveTask(newParentId, tasks[newParentId])
      }
    }
    tasks[id].parentTaskId = newParentId
  }

  if (prevStatus !== 'archived' && tasks[id].status === 'archived') {
    tasks[id].archivedAt = Date.now()
  }

  saveTask(id, tasks[id])
  const mission = ensureMissionForTask(tasks[id], { source: 'manual' })
  if (tasks[id].status === 'completed' || tasks[id].status === 'failed' || tasks[id].status === 'cancelled') {
    noteMissionTaskFinished(tasks[id], tasks[id].status, tasks[id].id)
  }
  logActivity({ entityType: 'task', entityId: id, action: 'updated', actor: 'user', summary: `Task updated: "${tasks[id].title}" (${prevStatus} → ${tasks[id].status})` })
  if (prevStatus !== tasks[id].status) {
    pushMainLoopEventToMainSessions({
      type: 'task_status_changed',
      text: `Task "${tasks[id].title}" (${id}) moved ${prevStatus} → ${tasks[id].status}.`,
    })
  }

  if (prevStatus !== tasks[id].status && tasks[id].status === 'cancelled') {
    disableSessionHeartbeat(tasks[id].sessionId)
    notify('tasks')
    return {
      ok: true as const,
      payload: enrichTaskWithMissionSummary({
        ...tasks[id],
        missionId: mission?.id || tasks[id].missionId || null,
      }),
    }
  }

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
      const agentExtensions = tasks[id].agentId ? getEnabledCapabilityIds(loadAgents()[tasks[id].agentId]) : []
      getExtensionManager().runHook(
        'onTaskComplete',
        { taskId: id, result: tasks[id].result },
        { enabledIds: agentExtensions },
      )
    }

    if (tasks[id].sessionId) {
      enqueueSystemEvent(tasks[id].sessionId, `Task ${tasks[id].status}: ${tasks[id].title}`)
    }
    if (tasks[id].agentId) {
      dispatchWake({
        mode: 'immediate',
        agentId: tasks[id].agentId,
        sessionId: tasks[id].sessionId || undefined,
        eventId: `task:${id}:${tasks[id].status}`,
        reason: 'task-completed',
        source: `task:${id}`,
        resumeMessage: `Task ${tasks[id].status}: ${tasks[id].title}`,
        detail: tasks[id].status === 'failed'
          ? String(tasks[id].error || '').slice(0, 400)
          : JSON.stringify(tasks[id].result || '').slice(0, 400),
      })
    }
  }

  if (tasks[id].status === 'queued') {
    const blockers = Array.isArray(tasks[id].blockedBy) ? tasks[id].blockedBy : []
    const incompleteBlocker = blockers.find((bid: string) => tasks[bid] && tasks[bid].status !== 'completed')
    if (incompleteBlocker) {
      tasks[id].status = prevStatus
      tasks[id].updatedAt = Date.now()
      saveTask(id, tasks[id])
      return {
        ok: false as const,
        status: 409 as const,
        payload: { error: 'Cannot queue: blocked by incomplete tasks', blockedBy: incompleteBlocker },
      }
    }
  }

  if (tasks[id].status === 'completed') {
    const unblockedIds = cascadeUnblock(tasks, id)
    if (unblockedIds.length > 0) {
      saveTaskMany([
        [id, tasks[id]],
        ...unblockedIds.map((uid) => [uid, tasks[uid]] as [string, BoardTask]),
      ])
      for (const uid of unblockedIds) {
        enqueueTask(uid)
      }
    }
  }

  if (prevStatus !== 'queued' && tasks[id].status === 'queued') {
    enqueueTask(id)
  }

  notify('tasks')
  return {
    ok: true as const,
    payload: enrichTaskWithMissionSummary({
      ...tasks[id],
      missionId: mission?.id || tasks[id].missionId || null,
    }),
  }
}

export function archiveTaskFromRoute(id: string) {
  const task = loadTask(id)
  if (!task) return { ok: false as const }
  task.status = 'archived'
  task.archivedAt = Date.now()
  task.updatedAt = Date.now()
  saveTask(id, task)
  logActivity({ entityType: 'task', entityId: id, action: 'deleted', actor: 'user', summary: `Task archived: "${task.title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_archived',
    text: `Task archived: "${task.title}" (${id}).`,
  })
  notify('tasks')
  return { ok: true as const, payload: task }
}

export function createTaskFromRoute(body: Record<string, unknown>) {
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
  if (Array.isArray(body.blockedBy) && body.blockedBy.length > 0) {
    const dagResult = validateDag(tasks, id, body.blockedBy)
    if (!dagResult.valid) {
      return {
        ok: false as const,
        status: 400 as const,
        payload: { error: 'Dependency cycle detected', cycle: dagResult.cycle },
      }
    }
  }
  const description = typeof body.description === 'string' ? body.description : ''
  const resolvedAgentId = description
    ? resolveTaskAgentFromDescription(description, (body.agentId as string) || '', loadAgents())
    : ((body.agentId as string) || '')

  const prepared = prepareTaskCreation({
    id,
    input: {
      ...body,
      agentId: resolvedAgentId,
    },
    tasks,
    now,
    settings,
    seed: {
      projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : null,
      goalContract: body.goalContract || null,
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
      file: typeof body.file === 'string' ? body.file : null,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      result: typeof body.result === 'string' ? body.result : null,
      error: typeof body.error === 'string' ? body.error : null,
      outputFiles: Array.isArray(body.outputFiles)
        ? body.outputFiles.filter((entry): entry is string => typeof entry === 'string').slice(0, 24)
        : [],
      artifacts: Array.isArray(body.artifacts)
        ? body.artifacts
            .filter((artifact) => artifact && typeof artifact === 'object')
            .map((artifact) => {
              const row = artifact as { url?: unknown; type?: unknown; filename?: unknown }
              const normalizedType = String(row.type || '')
              return {
                url: String(row.url || ''),
                type: ['image', 'video', 'pdf', 'file'].includes(normalizedType)
                  ? (normalizedType as 'image' | 'video' | 'pdf' | 'file')
                  : 'file',
                filename: String(row.filename || ''),
              }
            })
            .filter((artifact) => artifact.url && artifact.filename)
            .slice(0, 24)
        : [],
      archivedAt: null,
      attempts: 0,
      maxAttempts,
      retryBackoffSec,
      retryScheduledAt: null,
      deadLetteredAt: null,
      checkpoint: null,
      blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.filter((s): s is string => typeof s === 'string') : [],
      blocks: Array.isArray(body.blocks) ? body.blocks.filter((s): s is string => typeof s === 'string') : [],
      tags: Array.isArray(body.tags) ? body.tags.filter((s): s is string => typeof s === 'string') : [],
      dueAt: typeof body.dueAt === 'number' ? body.dueAt : null,
      customFields: body.customFields && typeof body.customFields === 'object' ? body.customFields : undefined,
      priority: body.priority && ['low', 'medium', 'high', 'critical'].includes(String(body.priority))
        ? body.priority as BoardTask['priority']
        : undefined,
    },
  })
  if (!prepared.ok) {
    return { ok: false as const, status: 400 as const, payload: { error: prepared.error } }
  }
  if (prepared.duplicate) {
    return { ok: true as const, payload: { ...prepared.duplicate, deduplicated: true } }
  }

  const task = prepared.task
  if (task.status === 'completed') {
    const agentExtensions = resolvedAgentId ? getEnabledCapabilityIds(loadAgents()[resolvedAgentId]) : []
    getExtensionManager().runHook(
      'onTaskComplete',
      { taskId: id, result: task.result },
      { enabledIds: agentExtensions },
    )
  }

  const parentTaskId = typeof body.parentTaskId === 'string' && body.parentTaskId.trim() ? body.parentTaskId.trim() : null
  if (parentTaskId) {
    task.parentTaskId = parentTaskId
    const parentTask = tasks[parentTaskId]
    if (parentTask) {
      const subtaskIds = Array.isArray(parentTask.subtaskIds) ? parentTask.subtaskIds : []
      if (!subtaskIds.includes(id)) {
        parentTask.subtaskIds = [...subtaskIds, id]
        parentTask.updatedAt = now
        saveTask(parentTaskId, parentTask)
      }
    }
  }

  saveTask(id, task)
  const mission = ensureMissionForTask(task, { source: 'manual' })
  const finalTask = enrichTaskWithMissionSummary({
    ...task,
    missionId: mission?.id || task.missionId || null,
  })
  logActivity({ entityType: 'task', entityId: id, action: 'created', actor: 'user', summary: `Task created: "${task.title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_created',
    text: `Task created: "${task.title}" (${id}) with status ${task.status}.`,
  })
  if (task.status === 'queued') {
    enqueueTask(id)
  }
  notify('tasks')
  return { ok: true as const, payload: finalTask }
}

export function bulkUpdateTasksFromRoute(body: Record<string, unknown>) {
  const ids = body.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false as const, status: 400 as const, payload: { error: 'ids must be a non-empty array' } }
  }
  const taskIds = ids.filter((id): id is string => typeof id === 'string')
  if (taskIds.length === 0) {
    return { ok: false as const, status: 400 as const, payload: { error: 'No valid task IDs provided' } }
  }
  const tasks = loadTasks()
  let updated = 0
  const results: string[] = []

  for (const id of taskIds) {
    if (!tasks[id]) continue
    const prevStatus = tasks[id].status
    if (typeof body.status === 'string' && VALID_BULK_STATUSES.includes(body.status as BoardTaskStatus)) {
      tasks[id].status = body.status as BoardTaskStatus
      if (body.status === 'archived' && prevStatus !== 'archived') {
        tasks[id].archivedAt = Date.now()
      }
    }
    if ('agentId' in body) {
      tasks[id].agentId = body.agentId === null ? '' : String(body.agentId)
    }
    if ('projectId' in body) {
      if (body.projectId === null) delete tasks[id].projectId
      else tasks[id].projectId = String(body.projectId)
    }
    tasks[id].updatedAt = Date.now()
    updated += 1
    results.push(id)
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
  saveTaskMany(results.map((id) => [id, tasks[id]] as [string, BoardTask]))
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
  return { ok: true as const, payload: { updated, ids: results } }
}

export function deleteTasksByFilter(filter: string | null) {
  const tasks = loadTasks()
  let removed = 0
  const shouldRemove = (task: { status: string; sourceType?: string }) =>
    filter === 'all'
    || (filter === 'schedule' && task.sourceType === 'schedule')
    || (filter === 'done' && (task.status === 'completed' || task.status === 'failed'))
    || (!filter && task.status === 'archived')

  for (const [id, task] of Object.entries(tasks)) {
    if (!shouldRemove(task as { status: string; sourceType?: string })) continue
    deleteTask(id)
    removed += 1
  }
  notify('tasks')
  return { removed, remaining: Object.keys(tasks).length - removed }
}
