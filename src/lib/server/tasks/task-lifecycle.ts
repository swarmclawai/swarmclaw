import { genId } from '@/lib/id'
import type { BoardTask, BoardTaskStatus, Schedule, TaskComment } from '@/types'

import { ensureTaskCompletionReport, type TaskReportArtifact } from '@/lib/server/tasks/task-reports'
import {
  formatValidationFailure,
  validateTaskCompletion,
  type TaskCompletionValidation,
} from '@/lib/server/tasks/task-validation'

export interface BuildBoardTaskInput {
  id?: string
  title: string
  description?: string | null
  agentId: string
  now: number
  status?: BoardTaskStatus
  seed?: Record<string, unknown>
}

export function buildBoardTask(input: BuildBoardTaskInput): BoardTask {
  const id = input.id || genId()
  const seed = input.seed ? { ...input.seed } : {}
  const seedStatus = typeof seed.status === 'string' ? seed.status as BoardTaskStatus : undefined
  const task = {
    sessionId: null,
    result: null,
    error: null,
    createdAt: input.now,
    updatedAt: input.now,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    ...seed,
    id,
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? seedStatus ?? 'backlog',
    agentId: input.agentId,
  } as BoardTask
  return task
}

export interface ResetTaskForRerunOptions {
  title: string
  now: number
  runNumber?: number | null
}

export function resetTaskForRerun(task: BoardTask, options: ResetTaskForRerunOptions): BoardTask {
  const stats = task as unknown as Record<string, unknown>
  stats.totalRuns = ((stats.totalRuns as number) || 0) + 1
  if (task.status === 'completed') stats.totalCompleted = ((stats.totalCompleted as number) || 0) + 1
  if (task.status === 'failed') stats.totalFailed = ((stats.totalFailed as number) || 0) + 1

  task.status = 'backlog'
  task.title = options.title
  task.result = null
  task.error = null
  task.outputFiles = []
  task.artifacts = []
  task.sessionId = null
  task.completionReportPath = null
  task.updatedAt = options.now
  task.queuedAt = null
  task.startedAt = null
  task.completedAt = null
  task.archivedAt = null
  task.attempts = 0
  task.retryScheduledAt = null
  task.deadLetteredAt = null
  task.validation = null
  if (options.runNumber !== undefined) stats.runNumber = options.runNumber
  return task
}

export interface PrepareScheduledTaskRunOptions {
  schedule: Pick<
    Schedule,
    | 'id'
    | 'name'
    | 'agentId'
    | 'taskPrompt'
    | 'linkedTaskId'
    | 'runNumber'
    | 'createdInSessionId'
    | 'createdByAgentId'
    | 'followupConnectorId'
    | 'followupChannelId'
    | 'followupThreadId'
    | 'followupSenderId'
    | 'followupSenderName'
  >
  tasks: Record<string, BoardTask>
  now: number
  scheduleSignature?: string | null
}

export function prepareScheduledTaskRun(params: PrepareScheduledTaskRunOptions): { taskId: string; task: BoardTask } {
  const { schedule, tasks, now, scheduleSignature } = params
  const title = `[Sched] ${schedule.name} (run #${schedule.runNumber})`
  const existingTaskId = typeof schedule.linkedTaskId === 'string' ? schedule.linkedTaskId : ''
  const existingTask = existingTaskId ? tasks[existingTaskId] : null

  if (existingTask && existingTask.status !== 'queued' && existingTask.status !== 'running') {
    return {
      taskId: existingTaskId,
      task: resetTaskForRerun(existingTask, {
        title,
        now,
        runNumber: schedule.runNumber,
      }),
    }
  }

  const task = buildBoardTask({
    title,
    description: schedule.taskPrompt || '',
    agentId: schedule.agentId,
    now,
    seed: {
      sourceType: 'schedule',
      sourceScheduleId: schedule.id,
      sourceScheduleName: schedule.name,
      sourceScheduleKey: scheduleSignature || null,
      createdInSessionId: schedule.createdInSessionId || null,
      createdByAgentId: schedule.createdByAgentId || null,
      followupConnectorId: schedule.followupConnectorId || null,
      followupChannelId: schedule.followupChannelId || null,
      followupThreadId: schedule.followupThreadId || null,
      followupSenderId: schedule.followupSenderId || null,
      followupSenderName: schedule.followupSenderName || null,
      runNumber: schedule.runNumber,
    },
  })
  tasks[task.id] = task
  schedule.linkedTaskId = task.id
  return { taskId: task.id, task }
}

function sameValidationReasons(a?: string[] | null, b?: string[] | null): boolean {
  const av = Array.isArray(a) ? a : []
  const bv = Array.isArray(b) ? b : []
  if (av.length !== bv.length) return false
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return false
  }
  return true
}

export function didTaskValidationChange(
  previous: TaskCompletionValidation | null | undefined,
  next: TaskCompletionValidation,
): boolean {
  return !previous
    || previous.ok !== next.ok
    || !sameValidationReasons(previous.reasons, next.reasons)
}

export function refreshTaskCompletionValidation(
  task: BoardTask,
  settings?: Record<string, unknown> | null,
): { report: TaskReportArtifact | null; validation: TaskCompletionValidation } {
  const report = ensureTaskCompletionReport(task)
  if (report?.relativePath) task.completionReportPath = report.relativePath
  const validation = validateTaskCompletion(task, { report, settings: settings || null })
  task.validation = validation
  return { report, validation }
}

export function markValidatedTaskCompleted(
  task: BoardTask,
  options: { now: number; preserveCompletedAt?: boolean } ,
): BoardTask {
  task.status = 'completed'
  task.completedAt = options.preserveCompletedAt ? (task.completedAt || options.now) : options.now
  task.updatedAt = options.now
  task.error = null
  return task
}

export function markInvalidCompletedTaskFailed(
  task: BoardTask,
  validation: TaskCompletionValidation,
  options: { now: number; comment?: Omit<TaskComment, 'id' | 'createdAt'> & { text: string } } ,
): BoardTask {
  task.status = 'failed'
  task.completedAt = null
  task.updatedAt = options.now
  task.error = formatValidationFailure(validation.reasons).slice(0, 500)
  if (options.comment) {
    if (!task.comments) task.comments = []
    task.comments.push({
      id: genId(),
      createdAt: options.now,
      ...options.comment,
    })
  }
  return task
}
