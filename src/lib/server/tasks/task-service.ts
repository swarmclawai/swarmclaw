import { computeTaskFingerprint, findDuplicateTask } from '@/lib/task-dedupe'
import type { AppSettings, BoardTask, BoardTaskStatus } from '@/types'

import { hasManagedAgentAssignmentInput } from '@/lib/server/agents/agent-assignment'
import {
  buildBoardTask,
  markInvalidCompletedTaskFailed,
  markValidatedTaskCompleted,
  refreshTaskCompletionValidation,
} from '@/lib/server/tasks/task-lifecycle'
import {
  normalizeTaskExecutionPolicy,
  syncTaskExecutionPolicyState,
} from '@/lib/server/tasks/task-execution-policy'
import { normalizeTaskQualityGate } from '@/lib/server/tasks/task-quality-gate'

const TASK_STATUS_VALUES = new Set([
  'backlog',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'archived',
])

const ASSIGNMENT_START_WORKFLOW_STATES = new Set(['triage', 'backlog', 'todo'])

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

export function resolveAssignmentWorkflowStateTransition(params: {
  previousAgentId?: string | null
  nextAgentId?: string | null
  previousWorkflowStateId?: string | null
  explicitWorkflowState?: boolean
}): string | null {
  if (params.explicitWorkflowState) return null
  const previousAgentId = typeof params.previousAgentId === 'string' ? params.previousAgentId.trim() : ''
  const nextAgentId = typeof params.nextAgentId === 'string' ? params.nextAgentId.trim() : ''
  if (!nextAgentId || nextAgentId === previousAgentId) return null
  const currentWorkflow = typeof params.previousWorkflowStateId === 'string' && params.previousWorkflowStateId.trim()
    ? params.previousWorkflowStateId.trim()
    : 'backlog'
  return ASSIGNMENT_START_WORKFLOW_STATES.has(currentWorkflow) ? 'in_progress' : null
}

export function deriveTaskTitle(input: { title?: unknown; description?: unknown }): string {
  const explicit = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : ''
  if (explicit && !/^untitled task$/i.test(explicit)) return explicit.slice(0, 120)

  const description = typeof input.description === 'string'
    ? input.description.replace(/\s+/g, ' ').trim()
    : ''
  if (!description) return ''

  const firstSentence = description.split(/[.!?]\s+/)[0] || description
  const compact = firstSentence
    .replace(/^please\s+/i, '')
    .replace(/^(create|make|build|implement|write)\s+/i, '')
    .trim()
  if (!compact) return ''
  return compact.slice(0, 120)
}

export function normalizeTaskStatusInput(status: unknown, prevStatus?: string): BoardTaskStatus | null {
  if (typeof status !== 'string') return null
  const normalized = status.trim().toLowerCase()
  if (!TASK_STATUS_VALUES.has(normalized)) return null
  if (normalized === 'running' && prevStatus !== 'running') return 'queued'
  return normalized as BoardTaskStatus
}

export function normalizeTaskIdList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of rawValues) {
    const normalized = typeof entry === 'string' ? entry.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export function pickFirstTaskId(value: unknown): string | null {
  const ids = normalizeTaskIdList(value)
  return ids[0] || null
}

export function applyTaskContinuationDefaults(
  parsed: Record<string, unknown>,
  tasks: Record<string, BoardTask>,
  explicitInput?: Record<string, unknown>,
): string | null {
  const explicit = explicitInput || parsed
  const continuationTaskId = pickFirstTaskId(parsed.continueFromTaskId)
    || pickFirstTaskId(parsed.followUpToTaskId)
    || pickFirstTaskId(parsed.resumeFromTaskId)
  const blockedBy = [
    ...normalizeTaskIdList(parsed.blockedBy),
    ...normalizeTaskIdList(parsed.dependsOn),
    ...normalizeTaskIdList(parsed.dependsOnTaskIds),
    ...normalizeTaskIdList(parsed.prerequisiteTaskIds),
  ]
  if (continuationTaskId && !blockedBy.includes(continuationTaskId)) {
    blockedBy.unshift(continuationTaskId)
  }
  if (blockedBy.length > 0) parsed.blockedBy = blockedBy

  if (continuationTaskId) {
    const sourceTask = tasks[continuationTaskId]
    if (!sourceTask) return `Error: source task "${continuationTaskId}" not found.`

    if (!Object.prototype.hasOwnProperty.call(explicit, 'projectId') && typeof sourceTask.projectId === 'string' && sourceTask.projectId.trim()) {
      parsed.projectId = sourceTask.projectId.trim()
    }
    if (
      !Object.prototype.hasOwnProperty.call(explicit, 'agentId')
      && !hasManagedAgentAssignmentInput(explicit)
      && typeof sourceTask.agentId === 'string'
      && sourceTask.agentId.trim()
    ) {
      parsed.agentId = sourceTask.agentId.trim()
    }
    if (!Object.prototype.hasOwnProperty.call(explicit, 'cwd') && typeof sourceTask.cwd === 'string' && sourceTask.cwd.trim()) {
      parsed.cwd = sourceTask.cwd.trim()
    }
    const sourceSessionId = typeof sourceTask.checkpoint?.lastSessionId === 'string' && sourceTask.checkpoint.lastSessionId.trim()
      ? sourceTask.checkpoint.lastSessionId.trim()
      : typeof sourceTask.sessionId === 'string' && sourceTask.sessionId.trim()
        ? sourceTask.sessionId.trim()
        : ''
    if (!Object.prototype.hasOwnProperty.call(explicit, 'sessionId') && sourceSessionId) {
      parsed.sessionId = sourceSessionId
    }

    const resumeFieldMap: Array<[keyof BoardTask, string]> = [
      ['cliResumeId', 'cliResumeId'],
      ['cliProvider', 'cliProvider'],
      ['claudeResumeId', 'claudeResumeId'],
      ['codexResumeId', 'codexResumeId'],
      ['opencodeResumeId', 'opencodeResumeId'],
      ['geminiResumeId', 'geminiResumeId'],
    ]
    for (const [sourceKey, targetKey] of resumeFieldMap) {
      const value = sourceTask[sourceKey]
      if (Object.prototype.hasOwnProperty.call(explicit, targetKey)) continue
      if (typeof value === 'string' && value.trim()) {
        parsed[targetKey] = value.trim()
      }
    }
  }

  for (const aliasKey of ['continueFromTaskId', 'followUpToTaskId', 'resumeFromTaskId', 'dependsOn', 'dependsOnTaskIds', 'prerequisiteTaskIds']) {
    delete parsed[aliasKey]
  }
  return null
}

export interface PrepareTaskCreationOptions {
  id?: string
  input: Record<string, unknown>
  tasks: Record<string, BoardTask>
  now: number
  settings?: AppSettings | Record<string, unknown> | null
  fallbackAgentId?: string | null
  creatorAgentId?: string | null
  autoQueueDelegatedTasks?: boolean
  defaultCwd?: string | null
  deriveTitleFromDescription?: boolean
  requireMeaningfulTitle?: boolean
  skipDuplicateCheck?: boolean
  seed?: Record<string, unknown>
}

export type PrepareTaskCreationResult =
  | { ok: false; error: string }
  | { ok: true; task: BoardTask; duplicate: BoardTask | null }

export function prepareTaskCreation(options: PrepareTaskCreationOptions): PrepareTaskCreationResult {
  const seed = options.seed ? { ...options.seed } : {}
  delete seed.workType
  const explicitTitle = typeof options.input.title === 'string' ? options.input.title.trim() : ''
  const derivedTitle = deriveTaskTitle(options.input)
  const nextTitle = options.deriveTitleFromDescription
    ? (derivedTitle || explicitTitle || 'Untitled Task')
    : (explicitTitle || derivedTitle || 'Untitled Task')

  if (options.requireMeaningfulTitle && (!nextTitle || /^untitled task$/i.test(nextTitle))) {
    return { ok: false, error: 'Error: manage_tasks create requires a specific title or a meaningful description.' }
  }

  const description = typeof options.input.description === 'string' ? options.input.description : ''
  const agentId = typeof options.input.agentId === 'string'
    ? options.input.agentId.trim()
    : (typeof options.fallbackAgentId === 'string' ? options.fallbackAgentId.trim() : '')
  const explicitStatus = Object.prototype.hasOwnProperty.call(options.input, 'status')
  let normalizedStatus = normalizeTaskStatusInput(options.input.status) || 'backlog'
  const creatorAgentId = typeof options.creatorAgentId === 'string' ? options.creatorAgentId.trim() : ''
  if (
    !explicitStatus
    && options.autoQueueDelegatedTasks === true
    && creatorAgentId
    && agentId
    && agentId !== creatorAgentId
  ) {
    normalizedStatus = 'queued'
  }
  const qualityGate = Object.prototype.hasOwnProperty.call(options.input, 'qualityGate')
    ? (options.input.qualityGate
      ? normalizeTaskQualityGate(options.input.qualityGate, options.settings || null)
      : null)
    : seed.qualityGate
  const executionPolicy = hasOwn(options.input, 'executionPolicy')
    ? normalizeTaskExecutionPolicy(options.input.executionPolicy, options.now)
    : (seed.executionPolicy
      ? normalizeTaskExecutionPolicy(seed.executionPolicy, options.now)
      : null)
  const executionPolicyState = executionPolicy
    ? syncTaskExecutionPolicyState(executionPolicy, seed.executionPolicyState as never, options.now)
    : null
  const cwd = Object.prototype.hasOwnProperty.call(options.input, 'cwd')
    ? (typeof options.input.cwd === 'string' ? options.input.cwd : null)
    : (typeof options.defaultCwd === 'string' ? options.defaultCwd : seed.cwd ?? null)

  const task = buildBoardTask({
    id: options.id,
    title: nextTitle,
    description,
    agentId,
    now: options.now,
    status: normalizedStatus,
    seed: {
      ...seed,
      cwd,
      qualityGate,
      executionPolicy,
      executionPolicyState,
    },
  })
  if (!task.workflowStateId && task.agentId) {
    task.workflowStateId = 'in_progress'
  }
  task.fingerprint = computeTaskFingerprint(task.title || 'Untitled Task', task.agentId || '')

  const duplicate = !options.skipDuplicateCheck && task.fingerprint
    ? findDuplicateTask(options.tasks, { fingerprint: task.fingerprint })
    : null
  if (duplicate) {
    return { ok: true, task, duplicate }
  }

  if (task.status === 'completed') {
    const { validation } = refreshTaskCompletionValidation(task, options.settings)
    if (validation.ok) {
      markValidatedTaskCompleted(task, { now: options.now })
    } else {
      markInvalidCompletedTaskFailed(task, validation, { now: options.now })
    }
  }

  return { ok: true, task, duplicate: null }
}

export interface ApplyTaskPatchOptions {
  task: BoardTask
  patch: Record<string, unknown>
  now: number
  settings?: AppSettings | Record<string, unknown> | null
  preserveCompletedAt?: boolean
  clearProjectIdWhenNull?: boolean
  invalidCompletionCommentAuthor?: string | null
}

export function applyTaskPatch(options: ApplyTaskPatchOptions): BoardTask {
  const nextPatch = { ...options.patch }
  const previousAgentId = options.task.agentId
  const previousWorkflowStateId = options.task.workflowStateId || null
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'status')) {
    const normalized = normalizeTaskStatusInput(nextPatch.status, options.task.status)
    if (normalized) nextPatch.status = normalized
    else delete nextPatch.status
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'qualityGate')) {
    nextPatch.qualityGate = nextPatch.qualityGate
      ? normalizeTaskQualityGate(nextPatch.qualityGate, options.settings || null)
      : null
  }
  if (hasOwn(nextPatch, 'executionPolicy')) {
    const normalizedPolicy = nextPatch.executionPolicy
      ? normalizeTaskExecutionPolicy(nextPatch.executionPolicy, options.now)
      : null
    nextPatch.executionPolicy = normalizedPolicy
    nextPatch.executionPolicyState = normalizedPolicy
      ? syncTaskExecutionPolicyState(normalizedPolicy, options.task.executionPolicyState, options.now)
      : null
  } else if (options.task.executionPolicy) {
    options.task.executionPolicy = normalizeTaskExecutionPolicy(options.task.executionPolicy, options.now)
    options.task.executionPolicyState = syncTaskExecutionPolicyState(
      options.task.executionPolicy,
      options.task.executionPolicyState,
      options.now,
    )
  }

  Object.assign(options.task, nextPatch, { updatedAt: options.now })
  if (options.clearProjectIdWhenNull && nextPatch.projectId === null) delete options.task.projectId
  const workflowTransition = resolveAssignmentWorkflowStateTransition({
    previousAgentId,
    nextAgentId: options.task.agentId,
    previousWorkflowStateId,
    explicitWorkflowState: hasOwn(nextPatch, 'workflowStateId'),
  })
  if (workflowTransition) options.task.workflowStateId = workflowTransition

  if (options.task.status === 'completed') {
    const { validation } = refreshTaskCompletionValidation(options.task, options.settings)
    if (validation.ok) {
      markValidatedTaskCompleted(options.task, {
        now: options.now,
        preserveCompletedAt: options.preserveCompletedAt,
      })
    } else {
      markInvalidCompletedTaskFailed(options.task, validation, {
        now: options.now,
        comment: options.invalidCompletionCommentAuthor
          ? {
              author: options.invalidCompletionCommentAuthor,
              text: `Completion validation failed.\n\n${validation.reasons.map((reason) => `- ${reason}`).join('\n')}`,
            }
          : undefined,
      })
    }
  }

  return options.task
}
