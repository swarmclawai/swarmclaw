import { genId } from '@/lib/id'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import { createNotification } from '@/lib/server/create-notification'
import { validateDag, cascadeUnblock } from '@/lib/server/dag-validation'
import { getExtensionManager } from '@/lib/server/extensions'
import {
  disableSessionHeartbeat,
  enqueueTask,
  recoverStalledRunningTasks,
  validateCompletedTasksQueue,
} from '@/lib/server/runtime/queue'
import { dispatchWake } from '@/lib/server/runtime/wake-dispatcher'
import { serviceFail, serviceOk } from '@/lib/server/service-result'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import {
  deleteTask,
  loadTask,
  loadTasks,
  saveTask,
  saveTaskMany,
} from '@/lib/server/tasks/task-repository'
import {
  computeTaskLiveness,
  prepareTaskExecutionWorkspace,
  type PrepareTaskExecutionWorkspaceOptions,
} from '@/lib/server/tasks/task-execution-workspace'
import { resolveTaskAgentForCreate } from '@/lib/server/tasks/task-mention'
import {
  describeTaskExecutionPolicy,
  isTaskExecutionPolicySatisfied,
  normalizeTaskExecutionPolicy,
  recordTaskExecutionPolicyDecision,
  syncTaskExecutionPolicyState,
  taskExecutionPolicyBlockReason,
  type RecordTaskExecutionPolicyDecisionInput,
} from '@/lib/server/tasks/task-execution-policy'
import {
  applyTaskPatch,
  normalizeTaskStatusInput,
  prepareTaskCreation,
  resolveAssignmentWorkflowStateTransition,
} from '@/lib/server/tasks/task-service'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { queueSwarmFeedTaskCompletionWake } from '@/lib/server/swarmfeed-runtime'
import { notify } from '@/lib/server/ws-hub'
import type { BoardTask, BoardTaskStatus, TaskComment } from '@/types'
import type { ServiceResult } from '@/lib/server/service-result'

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
  const listed: Record<string, BoardTask> = {}
  const now = Date.now()
  for (const [id, task] of Object.entries(allTasks)) {
    listed[id] = {
      ...task,
      liveness: computeTaskLiveness(task, allTasks, { now }),
    }
  }
  return listed
}

export function updateTaskFromRoute(id: string, body: Record<string, unknown>): ServiceResult<BoardTask> {
  const settings = loadSettings()
  const tasks = loadTasks()
  if (!tasks[id]) return serviceFail(404, 'Task not found')

  const prevStatus = tasks[id].status
  const now = Date.now()
  const shouldProvisionWorkspace = body.provisionWorkspace === true
  const workspaceOptions: Pick<PrepareTaskExecutionWorkspaceOptions, 'previewLinks' | 'runtimeServices'> = {
    previewLinks: Array.isArray(body.previewLinks)
      ? body.previewLinks as PrepareTaskExecutionWorkspaceOptions['previewLinks']
      : undefined,
    runtimeServices: Array.isArray(body.runtimeServices)
      ? body.runtimeServices as PrepareTaskExecutionWorkspaceOptions['runtimeServices']
      : undefined,
  }
  const patchBody = { ...body }
  delete patchBody.provisionWorkspace
  delete patchBody.previewLinks
  delete patchBody.runtimeServices

  if (Array.isArray(body.blockedBy)) {
    const dagResult = validateDag(tasks, id, body.blockedBy)
    if (!dagResult.valid) {
      return serviceFail(400, 'Dependency cycle detected')
    }
  }

  const requestedStatus = normalizeTaskStatusInput(body.status, prevStatus)
  if (Object.prototype.hasOwnProperty.call(body, 'status') && requestedStatus === 'completed') {
    const policyForCompletion = Object.prototype.hasOwnProperty.call(body, 'executionPolicy')
      ? normalizeTaskExecutionPolicy(body.executionPolicy, now)
      : normalizeTaskExecutionPolicy(tasks[id].executionPolicy, now)
    const stateForCompletion = syncTaskExecutionPolicyState(
      policyForCompletion,
      tasks[id].executionPolicyState,
      now,
    )
    if (!isTaskExecutionPolicySatisfied({
      executionPolicy: policyForCompletion,
      executionPolicyState: stateForCompletion,
    })) {
      const reason = taskExecutionPolicyBlockReason({
        executionPolicy: policyForCompletion,
        executionPolicyState: stateForCompletion,
      }) || 'Execution policy is not complete.'
      return serviceFail(409, reason)
    }
  }

  if (body.appendComment) {
    const appendedComment = normalizeTaskCommentInput(body.appendComment)
    if (!appendedComment) {
      return serviceFail(400, 'Invalid task comment payload')
    }
    if (!tasks[id].comments) tasks[id].comments = []
    tasks[id].comments.push(appendedComment)
    tasks[id].updatedAt = now
  } else {
    applyTaskPatch({
      task: tasks[id],
      patch: patchBody,
      now,
      settings,
      preserveCompletedAt: true,
      clearProjectIdWhenNull: true,
      invalidCompletionCommentAuthor: 'System',
    })
  }
  tasks[id].id = id
  tasks[id].executionPolicy = normalizeTaskExecutionPolicy(tasks[id].executionPolicy, now)
  tasks[id].executionPolicyState = syncTaskExecutionPolicyState(
    tasks[id].executionPolicy,
    tasks[id].executionPolicyState,
    now,
  )

  if (typeof body.parentTaskId === 'string' || body.parentTaskId === null) {
    const oldParentId = tasks[id].parentTaskId
    const newParentId = typeof body.parentTaskId === 'string' && body.parentTaskId.trim() ? body.parentTaskId.trim() : null
    if (oldParentId && oldParentId !== newParentId && tasks[oldParentId]) {
      const oldSubs = Array.isArray(tasks[oldParentId].subtaskIds) ? tasks[oldParentId].subtaskIds : []
      tasks[oldParentId].subtaskIds = oldSubs.filter((s: string) => s !== id)
      tasks[oldParentId].updatedAt = now
      saveTask(oldParentId, tasks[oldParentId])
    }
    if (newParentId && tasks[newParentId]) {
      const newSubs = Array.isArray(tasks[newParentId].subtaskIds) ? tasks[newParentId].subtaskIds : []
      if (!newSubs.includes(id)) {
        tasks[newParentId].subtaskIds = [...newSubs, id]
        tasks[newParentId].updatedAt = now
        saveTask(newParentId, tasks[newParentId])
      }
    }
    tasks[id].parentTaskId = newParentId
  }

  if (shouldProvisionWorkspace || workspaceOptions.previewLinks || workspaceOptions.runtimeServices) {
    Object.assign(tasks[id], prepareTaskExecutionWorkspace(tasks[id], {
      now,
      actor: 'user',
      tasks,
      ...workspaceOptions,
    }))
    tasks[id].updatedAt = now
  } else {
    tasks[id].liveness = computeTaskLiveness(tasks[id], tasks, { now })
  }

  if (prevStatus !== 'archived' && tasks[id].status === 'archived') {
    tasks[id].archivedAt = now
  }

  saveTask(id, tasks[id])
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
    return serviceOk(tasks[id])
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
      queueSwarmFeedTaskCompletionWake(tasks[id])
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
      tasks[id].updatedAt = now
      tasks[id].liveness = computeTaskLiveness(tasks[id], tasks, { now })
      saveTask(id, tasks[id])
      return serviceFail(409, 'Cannot queue: blocked by incomplete tasks')
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
  return serviceOk(tasks[id])
}

export function retryTaskFromRoute(id: string): ServiceResult<BoardTask> {
  const tasks = loadTasks()
  const task = tasks[id]
  if (!task) return serviceFail(404, 'Task not found')
  if (task.status !== 'failed') {
    return serviceFail(409, 'Only failed tasks can be retried.')
  }

  const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : []
  const incompleteBlocker = blockers.find((bid: string) => tasks[bid] && tasks[bid].status !== 'completed')
  if (incompleteBlocker) {
    return serviceFail(409, 'Cannot retry: blocked by incomplete tasks')
  }

  const now = Date.now()
  if (!task.comments) task.comments = []
  task.comments.push({
    id: genId(),
    author: 'System',
    text: 'Task retry requested by operator.',
    createdAt: now,
  })
  task.status = 'queued'
  task.attempts = 0
  task.deadLetteredAt = null
  task.retryScheduledAt = null
  task.checkoutRunId = null
  task.error = null
  task.validation = null
  task.startedAt = null
  task.completedAt = null
  task.queuedAt = now
  task.updatedAt = now
  task.liveness = computeTaskLiveness(task, tasks, { now })

  saveTask(id, task)
  enqueueTask(id)
  logActivity({ entityType: 'task', entityId: id, action: 'queued', actor: 'user', summary: `Task retried: "${task.title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_queued',
    text: `Task retried and queued: "${task.title}" (${id}).`,
  })
  notify('tasks')
  return serviceOk(loadTask(id) || task)
}

export function decideTaskExecutionPolicyFromRoute(
  id: string,
  body: Record<string, unknown>,
): ServiceResult<{
  task: BoardTask
  policy: BoardTask['executionPolicy']
  state: BoardTask['executionPolicyState']
  summary: ReturnType<typeof describeTaskExecutionPolicy>
}> {
  const task = loadTask(id)
  if (!task) return serviceFail(404, 'Task not found')
  const input: RecordTaskExecutionPolicyDecisionInput = {
    action: body.action === 'request_changes' || body.action === 'reset' ? body.action : 'approve',
    stageId: typeof body.stageId === 'string' ? body.stageId : null,
    actor: typeof body.actor === 'string' ? body.actor : 'operator',
    note: typeof body.note === 'string' ? body.note : null,
  }
  const decided = recordTaskExecutionPolicyDecision(task, input)
  if (!decided.ok) return serviceFail(decided.status, decided.error)
  saveTask(id, decided.task)
  const stageTitle = decided.decision
    ? decided.task.executionPolicy?.stages.find((stage) => stage.id === decided.decision?.stageId)?.title || decided.decision.stageId
    : input.stageId || decided.task.executionPolicyState?.currentStageId || 'policy'
  const actionLabel = input.action === 'request_changes'
    ? 'changes requested'
    : input.action === 'reset'
      ? 'reset'
      : 'approved'
  logActivity({
    entityType: 'task',
    entityId: id,
    action: input.action === 'request_changes' ? 'rejected' : input.action === 'approve' ? 'approved' : 'updated',
    actor: input.actor || 'operator',
    summary: `Execution policy ${actionLabel}: "${decided.task.title}" (${stageTitle})`,
  })
  pushMainLoopEventToMainSessions({
    type: 'task_updated',
    text: `Task "${decided.task.title}" (${id}) execution policy ${actionLabel} at ${stageTitle}.`,
  })
  notify('tasks')
  return serviceOk({
    task: decided.task,
    policy: decided.task.executionPolicy || null,
    state: decided.task.executionPolicyState || null,
    summary: describeTaskExecutionPolicy(decided.task),
  })
}

export function archiveTaskFromRoute(id: string): ServiceResult<BoardTask> {
  const task = loadTask(id)
  if (!task) return serviceFail(404, 'Task not found')
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
  return serviceOk(task)
}

export function createTaskFromRoute(body: Record<string, unknown>): ServiceResult<BoardTask> {
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
      return serviceFail(400, 'Dependency cycle detected')
    }
  }
  const description = typeof body.description === 'string' ? body.description : ''
  const explicitAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const resolvedAgentId = resolveTaskAgentForCreate(description, explicitAgentId, loadAgents())

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
    return serviceFail(400, prepared.error)
  }
  if (prepared.duplicate) {
    return serviceOk({ ...prepared.duplicate, deduplicated: true } as BoardTask)
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

  if (
    body.provisionWorkspace === true
    || Array.isArray(body.previewLinks)
    || Array.isArray(body.runtimeServices)
  ) {
    Object.assign(task, prepareTaskExecutionWorkspace(task, {
      now,
      actor: 'user',
      tasks,
      previewLinks: Array.isArray(body.previewLinks)
        ? body.previewLinks as PrepareTaskExecutionWorkspaceOptions['previewLinks']
        : undefined,
      runtimeServices: Array.isArray(body.runtimeServices)
        ? body.runtimeServices as PrepareTaskExecutionWorkspaceOptions['runtimeServices']
        : undefined,
    }))
  } else {
    task.liveness = computeTaskLiveness(task, tasks, { now })
  }

  saveTask(id, task)
  logActivity({ entityType: 'task', entityId: id, action: 'created', actor: 'user', summary: `Task created: "${task.title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_created',
    text: `Task created: "${task.title}" (${id}) with status ${task.status}.`,
  })
  if (task.status === 'queued') {
    enqueueTask(id)
  }
  notify('tasks')
  return serviceOk(task)
}

export function bulkUpdateTasksFromRoute(body: Record<string, unknown>): ServiceResult<{ updated: number; ids: string[] }> {
  const ids = body.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return serviceFail(400, 'ids must be a non-empty array')
  }
  const taskIds = ids.filter((id): id is string => typeof id === 'string')
  if (taskIds.length === 0) {
    return serviceFail(400, 'No valid task IDs provided')
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
      const previousAgentId = tasks[id].agentId
      const previousWorkflowStateId = tasks[id].workflowStateId || null
      tasks[id].agentId = body.agentId === null ? '' : String(body.agentId)
      const workflowTransition = resolveAssignmentWorkflowStateTransition({
        previousAgentId,
        nextAgentId: tasks[id].agentId,
        previousWorkflowStateId,
        explicitWorkflowState: Object.prototype.hasOwnProperty.call(body, 'workflowStateId'),
      })
      if (workflowTransition) tasks[id].workflowStateId = workflowTransition
    }
    if ('projectId' in body) {
      if (body.projectId === null) delete tasks[id].projectId
      else tasks[id].projectId = String(body.projectId)
    }
    if ('workflowStateId' in body) {
      if (body.workflowStateId === null) delete tasks[id].workflowStateId
      else tasks[id].workflowStateId = String(body.workflowStateId)
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
  return serviceOk({ updated, ids: results })
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
