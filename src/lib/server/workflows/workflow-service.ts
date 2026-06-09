import { genId } from '@/lib/id'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { appendProtocolEvent } from '@/lib/server/protocols/protocol-agent-turn'
import { loadProtocolRunById } from '@/lib/server/protocols/protocol-normalization'
import { patchProtocolRun, loadProtocolRunEventsByRunId } from '@/lib/server/protocols/protocol-run-repository'
import { createProtocolRun } from '@/lib/server/protocols/protocol-service'
import { createProtocolDispatchedTask } from '@/lib/server/protocols/protocol-task-dispatch'
import { cleanText, uniqueIds } from '@/lib/server/protocols/protocol-types'
import { serviceFail, serviceOk, type ServiceResult } from '@/lib/server/service-result'
import { loadTasks, saveTaskMany } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import type {
  BoardTask,
  WorkflowBundleLaunchResult,
  WorkflowBundleSpec,
  WorkflowBundleTaskSpec,
  WorkflowContinuationResult,
  WorkflowGoalClass,
  WorkflowLedger,
  WorkflowLedgerEntry,
  WorkflowPlanDraft,
  WorkflowSafetyProfile,
} from '@/types'

const DEFAULT_FORBIDDEN_ACTIONS = [
  'inspect secrets',
  'print env files',
  'use credentials',
  'place live orders',
  'change schedules',
  'change autonomy',
  'change provider routing',
  'repair state database',
  'delete files',
  'expose public ports',
]

const DEFAULT_CHECKPOINT_ACTIONS = [
  'credential access',
  'live trading',
  'deployment',
  'schedule changes',
  'autonomy changes',
  'provider changes',
  'destructive cleanup',
  'state repair',
  'public exposure',
]

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown, max = 1_000): string {
  return cleanText(typeof value === 'string' ? value : '', max)
}

function stringList(value: unknown, maxItems = 64): string[] {
  return uniqueIds(Array.isArray(value) ? value : [], maxItems)
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(Number(value))) return fallback
  return Math.max(min, Math.min(max, Math.trunc(Number(value))))
}

function normalizeSafetyProfile(value: unknown): WorkflowSafetyProfile {
  const row = asRecord(value)
  const rawMode = stringValue(row.mode, 32)
  const mode: WorkflowSafetyProfile['mode'] = rawMode === 'implementation' || rawMode === 'release' || rawMode === 'standard'
    ? rawMode
    : 'read_only'
  return {
    mode,
    approvalRequired: row.approvalRequired !== false,
    quarantine: row.quarantine === true,
    allowedScopes: stringList(row.allowedScopes),
    forbiddenActions: uniqueIds([...DEFAULT_FORBIDDEN_ACTIONS, ...stringList(row.forbiddenActions)], 64),
    checkpointActions: uniqueIds([...DEFAULT_CHECKPOINT_ACTIONS, ...stringList(row.checkpointActions)], 64),
    maxActiveTasks: positiveInt(row.maxActiveTasks, 5, 1, 25),
    maxTotalTasks: positiveInt(row.maxTotalTasks, 12, 1, 100),
    maxIterations: positiveInt(row.maxIterations, 3, 1, 20),
    maxRetries: positiveInt(row.maxRetries, 2, 0, 10),
    maxElapsedMinutes: positiveInt(row.maxElapsedMinutes, 120, 1, 10_080),
  }
}

function normalizeTaskSpec(value: unknown, defaults: { cwd?: string | null; projectId?: string | null; safetyProfile: WorkflowSafetyProfile }): WorkflowBundleTaskSpec | null {
  const row = asRecord(value)
  const key = stringValue(row.key, 80)
  const title = stringValue(row.title, 160)
  const agentId = stringValue(row.agentId, 80)
  if (!key || !title || !agentId) return null
  const description = stringValue(row.description, 4_000) || title
  return {
    key,
    title,
    description,
    agentId,
    cwd: stringValue(row.cwd, 1_000) || defaults.cwd || null,
    projectId: stringValue(row.projectId, 80) || defaults.projectId || null,
    qualityGate: row.qualityGate && typeof row.qualityGate === 'object' ? row.qualityGate as never : null,
    executionPolicy: row.executionPolicy && typeof row.executionPolicy === 'object' ? row.executionPolicy as never : null,
    tags: uniqueIds(['workflow', ...stringList(row.tags)], 32),
    priority: ['low', 'medium', 'high', 'critical'].includes(String(row.priority)) ? row.priority as BoardTask['priority'] : undefined,
    maxAttempts: Number.isFinite(Number(row.maxAttempts)) ? positiveInt(row.maxAttempts, 3, 1, 20) : undefined,
    retryBackoffSec: Number.isFinite(Number(row.retryBackoffSec)) ? positiveInt(row.retryBackoffSec, 30, 1, 3600) : undefined,
    dependsOn: stringList(row.dependsOn),
    blocks: stringList(row.blocks),
    expectedMarker: stringValue(row.expectedMarker, 120) || null,
    allowedScope: stringList(row.allowedScope).length > 0 ? stringList(row.allowedScope) : defaults.safetyProfile.allowedScopes || [],
    forbiddenActions: uniqueIds([...(defaults.safetyProfile.forbiddenActions || []), ...stringList(row.forbiddenActions)], 96),
  }
}

function normalizeBundleSpec(value: unknown): ServiceResult<WorkflowBundleSpec> {
  const row = asRecord(value)
  const title = stringValue(row.title, 160)
  const goal = stringValue(row.goal, 4_000)
  if (!title) return serviceFail(400, 'Workflow bundle title is required.')
  if (!goal) return serviceFail(400, 'Workflow bundle goal is required.')

  const cwd = stringValue(row.cwd, 1_000) || null
  const projectId = stringValue(row.projectId, 80) || null
  const safetyProfile = normalizeSafetyProfile(row.safetyProfile)
  const rawTasks = Array.isArray(row.tasks) ? row.tasks : []
  const tasks = rawTasks
    .map((task) => normalizeTaskSpec(task, { cwd, projectId, safetyProfile }))
    .filter((task): task is WorkflowBundleTaskSpec => Boolean(task))

  if (tasks.length === 0) return serviceFail(400, 'Workflow bundle requires at least one valid task.')
  if (tasks.length > (safetyProfile.maxTotalTasks || 12)) {
    return serviceFail(400, `Workflow bundle exceeds maxTotalTasks (${safetyProfile.maxTotalTasks || 12}).`)
  }
  const keys = new Set<string>()
  for (const task of tasks) {
    if (keys.has(task.key)) return serviceFail(400, `Duplicate workflow task key: ${task.key}`)
    keys.add(task.key)
  }
  for (const task of tasks) {
    const missing = (task.dependsOn || []).filter((key) => !keys.has(key))
    if (missing.length > 0) return serviceFail(400, `Task "${task.key}" depends on unknown task key(s): ${missing.join(', ')}`)
  }
  if (row.queueImmediately === true && safetyProfile.approvalRequired) {
    return serviceFail(409, 'Approval-required workflow bundles must create backlog tasks first.')
  }

  return serviceOk({
    title,
    goal,
    cwd,
    projectId,
    safetyProfile,
    tasks,
    queueImmediately: row.queueImmediately === true,
    templateId: stringValue(row.templateId, 80) || null,
  })
}

function validateBundleAgents(spec: WorkflowBundleSpec): ServiceResult<Record<string, unknown>> {
  const agents = loadAgents()
  const missing = uniqueIds(spec.tasks.map((task) => task.agentId), 64).filter((agentId) => !agents[agentId])
  if (missing.length > 0) return serviceFail(400, `Unknown workflow agent(s): ${missing.join(', ')}`)
  return serviceOk(agents)
}

function orderedTaskIds(spec: WorkflowBundleSpec): Record<string, string> {
  const out: Record<string, string> = {}
  for (const task of spec.tasks) out[task.key] = genId()
  return out
}

function resolveBlockKeys(values: string[] | undefined, taskIdsByKey: Record<string, string>): string[] {
  return (values || []).map((value) => taskIdsByKey[value] || value).filter(Boolean)
}

function assertNoBundleCycles(spec: WorkflowBundleSpec): ServiceResult<true> {
  const taskByKey = new Map(spec.tasks.map((task) => [task.key, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false
    if (visited.has(key)) return true
    visiting.add(key)
    const task = taskByKey.get(key)
    for (const dep of task?.dependsOn || []) {
      if (!visit(dep)) return false
    }
    visiting.delete(key)
    visited.add(key)
    return true
  }
  for (const task of spec.tasks) {
    if (!visit(task.key)) return serviceFail(400, `Workflow bundle dependency cycle includes task key: ${task.key}`)
  }
  return serviceOk(true)
}

export function createWorkflowBundle(value: unknown): ServiceResult<WorkflowBundleLaunchResult> {
  const normalized = normalizeBundleSpec(value)
  if (!normalized.ok) return serviceFail(normalized.status, normalized.payload.error)
  const spec = normalized.payload
  const agentCheck = validateBundleAgents(spec)
  if (!agentCheck.ok) return serviceFail(agentCheck.status, agentCheck.payload.error)
  const cycleCheck = assertNoBundleCycles(spec)
  if (!cycleCheck.ok) return serviceFail(cycleCheck.status, cycleCheck.payload.error)

  const taskIdsByKey = orderedTaskIds(spec)
  const participantAgentIds = uniqueIds(spec.tasks.map((task) => task.agentId), 64)
  const run = createProtocolRun({
    title: spec.title,
    templateId: spec.templateId || 'custom',
    participantAgentIds,
    facilitatorAgentId: participantAgentIds[0] || null,
    sourceRef: { kind: 'api' },
    autoStart: false,
    createTranscript: false,
    steps: [
      { id: 'workflow_bundle_created', kind: 'wait', label: 'Workflow bundle created' },
    ],
    entryStepId: 'workflow_bundle_created',
    config: {
      goal: spec.goal,
      kickoffMessage: 'Workflow bundle tasks were created directly from an approved bundle.',
      createTranscript: false,
      autoEmitTasks: false,
      taskProjectId: spec.projectId || null,
      postSummaryToParent: false,
    },
    systemOwned: false,
  })

  const createdTasks: BoardTask[] = []
  for (const taskSpec of spec.tasks) {
    const blockedBy = resolveBlockKeys(taskSpec.dependsOn, taskIdsByKey)
    const blocks = resolveBlockKeys(taskSpec.blocks, taskIdsByKey)
    const created = createProtocolDispatchedTask({
      id: taskIdsByKey[taskSpec.key],
      runId: run.id,
      title: taskSpec.title,
      description: taskSpec.description,
      agentId: taskSpec.agentId,
      status: spec.queueImmediately ? 'queued' : 'backlog',
      cwd: taskSpec.cwd || spec.cwd || null,
      projectId: taskSpec.projectId || spec.projectId || null,
      qualityGate: taskSpec.qualityGate || null,
      executionPolicy: taskSpec.executionPolicy || null,
      tags: taskSpec.tags || [],
      priority: taskSpec.priority,
      maxAttempts: taskSpec.maxAttempts,
      retryBackoffSec: taskSpec.retryBackoffSec,
      blockedBy,
      blocks,
      expectedMarker: taskSpec.expectedMarker || null,
      allowedScope: taskSpec.allowedScope || spec.safetyProfile.allowedScopes,
      forbiddenActions: taskSpec.forbiddenActions || spec.safetyProfile.forbiddenActions,
      bundleId: run.id,
      bundleTaskKey: taskSpec.key,
      sourceType: 'manual',
      now: Date.now(),
    })
    if (!created.ok) {
      appendProtocolEvent(run.id, {
        type: 'failed',
        summary: created.payload.error,
      })
      patchProtocolRun(run.id, (current) => current ? {
        ...current,
        status: 'failed',
        lastError: created.payload.error,
        endedAt: Date.now(),
        updatedAt: Date.now(),
      } : null)
      return serviceFail(created.status, created.payload.error)
    }
    createdTasks.push(created.payload)
    appendProtocolEvent(run.id, {
      type: 'task_emitted',
      taskId: created.payload.id,
      summary: `Workflow task created: ${created.payload.title}`,
      data: {
        workflowEvent: 'workflow_task_created',
        taskKey: taskSpec.key,
        agentId: taskSpec.agentId,
        expectedMarker: taskSpec.expectedMarker || null,
      },
    })
  }

  const tasks = loadTasks()
  const changed = new Map<string, BoardTask>()
  for (const taskSpec of spec.tasks) {
    const dependentId = taskIdsByKey[taskSpec.key]
    for (const blockerId of resolveBlockKeys(taskSpec.dependsOn, taskIdsByKey)) {
      const blocker = tasks[blockerId]
      if (!blocker) continue
      const blocks = Array.isArray(blocker.blocks) ? blocker.blocks : []
      if (!blocks.includes(dependentId)) {
        blocker.blocks = [...blocks, dependentId]
        blocker.updatedAt = Date.now()
        changed.set(blocker.id, blocker)
      }
    }
  }
  if (changed.size > 0) saveTaskMany(Array.from(changed).map(([id, task]) => [id, task]))

  const createdTaskIds = createdTasks.map((task) => task.id)
  const updatedRun = patchProtocolRun(run.id, (current) => current ? {
    ...current,
    status: 'waiting',
    waitingReason: spec.queueImmediately
      ? 'Workflow bundle created and eligible tasks queued.'
      : 'Workflow bundle created in backlog for operator review.',
    createdTaskIds,
    updatedAt: Date.now(),
  } : null) || run

  appendProtocolEvent(run.id, {
    type: 'waiting',
    summary: spec.queueImmediately
      ? 'Workflow bundle launched with queued tasks.'
      : 'Workflow bundle created backlog tasks awaiting operator queueing.',
    data: {
      workflowEvent: 'workflow_bundle_created',
      taskIds: createdTaskIds,
      taskKeys: spec.tasks.map((task) => task.key),
      safetyProfile: spec.safetyProfile,
    },
  })
  notify('tasks')
  return serviceOk({
    run: updatedRun,
    taskIds: createdTaskIds,
    tasks: createdTasks,
    queued: spec.queueImmediately === true,
  })
}

export function classifyWorkflowGoal(goal: string): WorkflowGoalClass {
  const text = goal.toLowerCase()
  if (/\brelease|publish|ship|deploy\b/.test(text)) return 'release_gate'
  if (/\bmigration|migrate|schema\b/.test(text)) return 'migration'
  if (/\bbug|fix|debug|failure|failed\b/.test(text)) return 'bug_hunt'
  if (/\bimplement|build|change|write code|feature\b/.test(text)) return 'implementation'
  if (/\breview|audit|qa|risk\b/.test(text)) return 'review'
  if (/\bresearch|investigate|compare\b/.test(text)) return 'research'
  if (/\btriage|classify|prioritize\b/.test(text)) return 'triage'
  return 'read_only_discovery'
}

function chooseAgentId(agents: Record<string, { id?: string; name?: string }>, preferredIds: string[], namePatterns: RegExp[]): string {
  for (const id of preferredIds) {
    if (agents[id]) return id
  }
  for (const agent of Object.values(agents)) {
    const id = typeof agent.id === 'string' ? agent.id : ''
    const name = typeof agent.name === 'string' ? agent.name : ''
    if (id && namePatterns.some((pattern) => pattern.test(name))) return id
  }
  return Object.keys(agents)[0] || ''
}

export function createWorkflowPlan(value: unknown): ServiceResult<WorkflowPlanDraft> {
  const row = asRecord(value)
  const goal = stringValue(row.goal, 4_000)
  if (!goal) return serviceFail(400, 'Workflow goal is required.')
  const title = stringValue(row.title, 160) || `Workflow: ${goal.slice(0, 80)}`
  const cwd = stringValue(row.cwd, 1_000) || null
  const projectId = stringValue(row.projectId, 80) || null
  const classification = classifyWorkflowGoal(goal)
  const agents = loadAgents() as Record<string, { id?: string; name?: string }>
  const builderId = chooseAgentId(agents, ['92b8cd6c'], [/builder/i])
  const reviewerId = chooseAgentId(agents, ['c2cd6ff9'], [/reviewer/i, /qa/i])
  const coordinatorId = chooseAgentId(agents, ['default', builderId], [/coordinator/i, /builder/i])
  if (!builderId || !reviewerId || !coordinatorId) {
    return serviceFail(409, 'At least one Builder, Reviewer QA, and Coordinator-capable agent is required to draft a workflow.')
  }
  const readOnly = classification !== 'implementation' && classification !== 'migration' && classification !== 'bug_hunt'
  const safetyProfile = normalizeSafetyProfile({
    ...(asRecord(row.safetyProfile)),
    mode: readOnly ? 'read_only' : 'standard',
    approvalRequired: true,
    allowedScopes: stringList(row.allowedScopes),
  })
  const markerPrefix = `WF-${classification.replace(/_/g, '-').toUpperCase()}`
  const bundle: WorkflowBundleSpec = {
    title,
    goal,
    cwd,
    projectId,
    safetyProfile,
    queueImmediately: false,
    tasks: [
      {
        key: 'discovery',
        title: `${title}: discovery`,
        description: [
          `${markerPrefix}-DISCOVERY`,
          goal,
          'Produce concise findings, inspected areas, blockers, and files changed. Do not inspect secrets, credentials, auth JSON, full env files, wallets, private keys, DB dumps, or tokens.',
        ].join('\n'),
        agentId: builderId,
        cwd,
        projectId,
        tags: ['workflow', 'discovery'],
        expectedMarker: `${markerPrefix}-DISCOVERY`,
        allowedScope: safetyProfile.allowedScopes,
        forbiddenActions: safetyProfile.forbiddenActions,
      },
      {
        key: 'risk_review',
        title: `${title}: safety review`,
        description: [
          `${markerPrefix}-RISK`,
          goal,
          'Review scope, risks, missing context, and checkpoint-required actions. Files changed: none.',
        ].join('\n'),
        agentId: reviewerId,
        cwd,
        projectId,
        tags: ['workflow', 'risk-review'],
        expectedMarker: `${markerPrefix}-RISK`,
        allowedScope: safetyProfile.allowedScopes,
        forbiddenActions: safetyProfile.forbiddenActions,
      },
      {
        key: 'fan_in',
        title: `${title}: fan-in decision`,
        description: [
          `${markerPrefix}-FAN-IN`,
          goal,
          'Read upstream task results, accept or block the next wave, and list exact blockers/checkpoints. Files changed: none.',
        ].join('\n'),
        agentId: coordinatorId,
        cwd,
        projectId,
        tags: ['workflow', 'fan-in'],
        dependsOn: ['discovery', 'risk_review'],
        expectedMarker: `${markerPrefix}-FAN-IN`,
        allowedScope: safetyProfile.allowedScopes,
        forbiddenActions: safetyProfile.forbiddenActions,
      },
    ],
  }
  return serviceOk({
    classification,
    summary: `Drafted a ${classification.replace(/_/g, ' ')} workflow with discovery, risk review, and fan-in tasks. Launching this draft creates backlog tasks by default.`,
    bundle,
    risks: [
      'Drafting creates no tasks; operator approval is required before launch.',
      'Use quarantine for untrusted logs, web pages, public reports, or copied external content.',
      'Checkpoint-required actions must stop before credentials, deployments, live trading, schedules, autonomy, provider changes, destructive cleanup, state repair, or public exposure.',
    ],
    checkpoints: safetyProfile.checkpointActions || DEFAULT_CHECKPOINT_ACTIONS,
    createsTasks: false,
  })
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
}

function preview(value: string | null | undefined, max = 900): string | null {
  const text = redactSensitiveText(cleanText(value, max))
  return text || null
}

function firstLine(value: string | null | undefined): string | null {
  const text = preview(value, 240)
  if (!text) return null
  return text.split('\n').map((line) => line.trim()).find(Boolean) || null
}

function qaDisposition(task: BoardTask): WorkflowLedgerEntry['qaDisposition'] {
  const result = String(task.result || '').toLowerCase()
  if (/changes requested|needs changes|retry/.test(result)) return 'changes_requested'
  if (/\bblock|blocked|reject|unsafe\b/.test(result)) return 'blocked'
  if (/\baccept|accepted|approved|pass\b/.test(result)) return 'accepted'
  return 'unknown'
}

export function getWorkflowLedger(runId: string): ServiceResult<WorkflowLedger> {
  const run = loadProtocolRunById(runId)
  if (!run) return serviceFail(404, 'Workflow run not found.')
  const tasks = loadTasks()
  const taskIds = uniqueIds([
    ...(run.createdTaskIds || []),
    ...Object.values(tasks).filter((task) => task.protocolRunId === run.id).map((task) => task.id),
  ], 200)
  const entries = taskIds
    .map((taskId): WorkflowLedgerEntry | null => {
      const task = tasks[taskId]
      if (!task) return null
      const blockers = (task.blockedBy || []).filter((blockerId) => {
        const blocker = tasks[blockerId]
        return blocker && blocker.status !== 'completed'
      })
      return {
        runId: run.id,
        taskId: task.id,
        taskKey: task.workflow?.bundleTaskKey || null,
        title: task.title,
        agentId: task.agentId,
        status: task.status,
        marker: firstLine(task.result) || firstLine(task.description),
        expectedMarker: task.workflow?.expectedMarker || null,
        allowedScope: task.workflow?.allowedScope || [],
        forbiddenActions: task.workflow?.forbiddenActions || [],
        filesChanged: Array.isArray(task.outputFiles) ? task.outputFiles.slice(0, 24) : [],
        verification: preview(task.verificationSummary || task.validation?.reasons?.join('; ') || null, 320),
        blockers,
        qaDisposition: qaDisposition(task),
        resultPreview: preview(task.result || task.error || null),
        updatedAt: task.updatedAt,
      }
    })
    .filter((entry): entry is WorkflowLedgerEntry => Boolean(entry))
    .sort((left, right) => left.updatedAt - right.updatedAt)
  return serviceOk({
    runId: run.id,
    runTitle: run.title,
    status: run.status,
    entries,
    eventCount: loadProtocolRunEventsByRunId(run.id).length,
    generatedAt: Date.now(),
  })
}

export function continueWorkflowRun(runId: string, value: unknown = {}): ServiceResult<WorkflowContinuationResult> {
  const ledgerResult = getWorkflowLedger(runId)
  if (!ledgerResult.ok) return serviceFail(ledgerResult.status, ledgerResult.payload.error)
  const ledger = ledgerResult.payload
  const row = asRecord(value)
  const active = ledger.entries.filter((entry) => ['queued', 'running'].includes(entry.status))
  const blockedBacklog = ledger.entries.filter((entry) => entry.status === 'backlog' && (entry.blockers || []).length > 0)
  const failed = ledger.entries.filter((entry) => entry.status === 'failed')
  const unfinished = ledger.entries.filter((entry) => !['completed', 'cancelled', 'archived'].includes(entry.status))
  if (ledger.entries.length === 0) {
    const draft = createWorkflowPlan({
      goal: stringValue(row.goal, 4_000) || ledger.runTitle,
      title: `${ledger.runTitle}: next workflow`,
      safetyProfile: row.safetyProfile,
    })
    return serviceOk({
      runId,
      state: 'needs_plan',
      summary: 'No workflow tasks are linked to this run yet.',
      nextAction: 'draft_next_bundle',
      draft: draft.ok ? draft.payload : null,
      ledger,
    })
  }
  if (failed.length > 0) {
    return serviceOk({
      runId,
      state: 'retry',
      summary: `${failed.length} workflow task${failed.length === 1 ? '' : 's'} failed; retry requires operator review.`,
      nextAction: 'retry_failed',
      draft: null,
      ledger,
    })
  }
  if (active.length > 0 || blockedBacklog.length > 0 || unfinished.length > 0) {
    return serviceOk({
      runId,
      state: 'waiting',
      summary: 'Workflow is still waiting on active, backlog, or blocked tasks.',
      nextAction: 'wait',
      draft: null,
      ledger,
    })
  }
  return serviceOk({
    runId,
    state: 'done',
    summary: 'All workflow tasks reached terminal successful or non-active states.',
    nextAction: 'none',
    draft: null,
    ledger,
  })
}
