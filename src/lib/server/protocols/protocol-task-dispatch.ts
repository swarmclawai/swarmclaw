import { genId } from '@/lib/id'
import { validateDag } from '@/lib/server/dag-validation'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { serviceFail, serviceOk, type ServiceResult } from '@/lib/server/service-result'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { loadTasks, saveTask } from '@/lib/server/tasks/task-repository'
import { prepareTaskCreation } from '@/lib/server/tasks/task-service'
import { notify } from '@/lib/server/ws-hub'
import type {
  BoardTask,
  BoardTaskStatus,
  TaskExecutionPolicy,
  TaskQualityGateConfig,
} from '@/types'

export interface CreateProtocolDispatchedTaskInput {
  id?: string
  runId: string
  title: string
  description?: string | null
  agentId: string
  status?: BoardTaskStatus
  cwd?: string | null
  projectId?: string | null
  qualityGate?: TaskQualityGateConfig | null
  executionPolicy?: TaskExecutionPolicy | null
  tags?: string[]
  priority?: BoardTask['priority']
  maxAttempts?: number
  retryBackoffSec?: number
  blockedBy?: string[]
  blocks?: string[]
  expectedMarker?: string | null
  allowedScope?: string[]
  forbiddenActions?: string[]
  bundleId?: string | null
  bundleTaskKey?: string | null
  sourceType?: BoardTask['sourceType']
  createdByAgentId?: string | null
  createdInSessionId?: string | null
  now?: number
}

function cleanStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function resolvePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(Number(value))) return fallback
  return Math.max(min, Math.min(max, Math.trunc(Number(value))))
}

export function createProtocolDispatchedTask(input: CreateProtocolDispatchedTaskInput): ServiceResult<BoardTask> {
  const now = input.now || Date.now()
  const settings = loadSettings()
  const tasks = loadTasks()
  const taskId = input.id || genId()
  const blockedBy = cleanStringList(input.blockedBy)
  const blocks = cleanStringList(input.blocks)
  const tags = cleanStringList(input.tags)
  const allowedScope = cleanStringList(input.allowedScope)
  const forbiddenActions = cleanStringList(input.forbiddenActions)

  if (blockedBy.length > 0) {
    const dagResult = validateDag(tasks, taskId, blockedBy)
    if (!dagResult.valid) return serviceFail(400, 'Dependency cycle detected')
  }

  const requestedStatus = input.status || 'queued'
  const incompleteBlocker = blockedBy.find((blockerId) => {
    const blocker = tasks[blockerId]
    return blocker && blocker.status !== 'completed'
  })
  const status = requestedStatus === 'queued' && incompleteBlocker ? 'backlog' : requestedStatus
  const maxAttempts = resolvePositiveInt(input.maxAttempts, Math.max(1, Math.trunc(Number(settings.defaultTaskMaxAttempts ?? 3))), 1, 20)
  const retryBackoffSec = resolvePositiveInt(input.retryBackoffSec, Math.max(1, Math.trunc(Number(settings.taskRetryBackoffSec ?? 30))), 1, 3600)

  const prepared = prepareTaskCreation({
    id: taskId,
    input: {
      title: input.title,
      description: input.description || '',
      agentId: input.agentId,
      status,
      cwd: input.cwd || null,
      projectId: input.projectId || null,
      qualityGate: input.qualityGate || null,
      executionPolicy: input.executionPolicy || null,
      tags,
      priority: input.priority,
      maxAttempts,
      retryBackoffSec,
      blockedBy,
      blocks,
    },
    tasks,
    now,
    settings,
    skipDuplicateCheck: true,
    seed: {
      protocolRunId: input.runId,
      sourceType: input.sourceType || 'manual',
      projectId: input.projectId || null,
      cwd: input.cwd || null,
      createdByAgentId: input.createdByAgentId || null,
      createdInSessionId: input.createdInSessionId || null,
      archivedAt: null,
      attempts: 0,
      maxAttempts,
      retryBackoffSec,
      retryScheduledAt: null,
      deadLetteredAt: null,
      checkpoint: null,
      blockedBy,
      blocks,
      tags: tags.includes('workflow') ? tags : ['workflow', ...tags],
      priority: input.priority,
      workflow: {
        bundleId: input.bundleId || null,
        bundleTaskKey: input.bundleTaskKey || null,
        expectedMarker: input.expectedMarker || null,
        allowedScope,
        forbiddenActions,
      },
    },
  })
  if (!prepared.ok) return serviceFail(400, prepared.error)

  const task = prepared.task
  saveTask(task.id, task)
  if (task.status === 'queued') enqueueTask(task.id)
  else notify('tasks')
  return serviceOk(task)
}
