import type { GoalContract } from './app-settings'

// --- Task Board ---

export type BoardTaskStatus = 'backlog' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'archived' | 'deferred'

export interface TaskComment {
  id: string
  author: string         // agent name or 'user'
  agentId?: string     // if from an agent
  text: string
  createdAt: number
}

export interface TaskQualityGateConfig {
  enabled?: boolean
  minResultChars?: number
  minEvidenceItems?: number
  requireVerification?: boolean
  requireArtifact?: boolean
  requireReport?: boolean
}

export type TaskExecutionPolicyStageKind = 'review' | 'approval' | 'verification'
export type TaskExecutionPolicyMode = 'before_completion' | 'advisory'

export interface TaskExecutionPolicyStage {
  id: string
  title: string
  kind: TaskExecutionPolicyStageKind
  description?: string | null
  actorHint?: string | null
  requiredDecisions?: number
}

export interface TaskExecutionPolicy {
  enabled?: boolean
  mode?: TaskExecutionPolicyMode
  stages: TaskExecutionPolicyStage[]
  createdAt?: number
  updatedAt?: number
}

export type TaskExecutionPolicyDecisionAction = 'approved' | 'changes_requested' | 'reset'

export interface TaskExecutionPolicyDecision {
  id: string
  stageId: string
  action: TaskExecutionPolicyDecisionAction
  actor: string
  note?: string | null
  decidedAt: number
}

export type TaskExecutionPolicyStageStatus = 'pending' | 'waiting' | 'approved' | 'changes_requested'
export type TaskExecutionPolicyStatus = 'disabled' | 'waiting' | 'approved' | 'changes_requested' | 'completed'

export interface TaskExecutionPolicyStageState {
  id: string
  status: TaskExecutionPolicyStageStatus
  requiredDecisions: number
  approvedDecisionCount: number
  lastDecisionAt?: number | null
}

export interface TaskExecutionPolicyState {
  status: TaskExecutionPolicyStatus
  currentStageId?: string | null
  currentStageIndex?: number | null
  stages: TaskExecutionPolicyStageState[]
  decisions: TaskExecutionPolicyDecision[]
  updatedAt: number
  completedAt?: number | null
}

export type TaskExecutionWorkspaceMode = 'task' | 'project' | 'custom'

export interface TaskPreviewLink {
  id: string
  label: string
  url: string
  kind: 'web' | 'api' | 'docs' | 'custom'
  port?: number | null
  addedAt: number
}

export interface TaskRuntimeService {
  id: string
  name: string
  status: 'planned' | 'running' | 'stopped' | 'failed' | 'unknown'
  command?: string | null
  url?: string | null
  port?: number | null
  startedAt?: number | null
  updatedAt: number
}

export interface TaskRuntimeEnvHint {
  key: string
  value: string
  description?: string
}

export interface TaskRuntimeContextPacket {
  taskId: string
  title: string
  description?: string
  status: BoardTaskStatus
  agentId: string
  projectId?: string | null
  workspacePath: string
  sourceCwd?: string | null
  mode: TaskExecutionWorkspaceMode
  preparedAt: number
  generatedAt: number
  previewLinks: TaskPreviewLink[]
  runtimeServices: TaskRuntimeService[]
  blockedBy?: string[]
  blocks?: string[]
  tags?: string[]
  upstreamResults?: BoardTask['upstreamResults']
  executionPolicy?: TaskExecutionPolicy | null
  executionPolicyState?: TaskExecutionPolicyState | null
}

export interface TaskWorkflowContext {
  bundleId?: string | null
  bundleTaskKey?: string | null
  expectedMarker?: string | null
  allowedScope?: string[]
  forbiddenActions?: string[]
}

export interface TaskExecutionWorkspace {
  path: string
  mode: TaskExecutionWorkspaceMode
  sourceCwd?: string | null
  projectId?: string | null
  preparedAt: number
  preparedBy?: string | null
  readmePath?: string | null
  contextPath?: string | null
  envPath?: string | null
  envHints?: TaskRuntimeEnvHint[]
  context?: TaskRuntimeContextPacket
  previewLinks: TaskPreviewLink[]
  runtimeServices: TaskRuntimeService[]
}

export type TaskLivenessState =
  | 'not_started'
  | 'ready'
  | 'queued'
  | 'blocked'
  | 'running'
  | 'stale'
  | 'retrying'
  | 'dead_lettered'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived'

export interface TaskLivenessSnapshot {
  state: TaskLivenessState
  reason: string
  checkedAt: number
  lastActivityAt?: number | null
  nextWakeAt?: number | null
  blockerTaskIds?: string[]
  staleMs?: number | null
}

export interface BoardTask {
  id: string
  title: string
  description: string
  status: BoardTaskStatus
  agentId: string
  protocolRunId?: string | null
  // Objective tracking (absorbed from missions)
  objective?: string | null
  successCriteria?: string[] | null
  verificationSummary?: string | null
  rootTaskId?: string | null
  projectId?: string
  goalContract?: GoalContract | null
  /** Reference to a Goal in the goal hierarchy. Takes precedence over goalContract when set. */
  goalId?: string | null
  cwd?: string | null
  file?: string | null
  sessionId?: string | null
  missionId?: string | null
  completionReportPath?: string | null
  result?: string | null
  error?: string | null
  outputFiles?: string[]
  artifacts?: Array<{
    url: string
    type: 'image' | 'video' | 'pdf' | 'file'
    filename: string
  }>
  executionWorkspace?: TaskExecutionWorkspace | null
  previewLinks?: TaskPreviewLink[]
  runtimeServices?: TaskRuntimeService[]
  liveness?: TaskLivenessSnapshot | null
  comments?: TaskComment[]
  images?: string[]
  createdByAgentId?: string | null
  createdInSessionId?: string | null
  followupConnectorId?: string | null
  followupChannelId?: string | null
  followupThreadId?: string | null
  followupSenderId?: string | null
  followupSenderName?: string | null
  delegatedByAgentId?: string | null
  delegatedFromTaskId?: string | null
  delegationDepth?: number | null
  createdAt: number
  updatedAt: number
  queuedAt?: number | null
  startedAt?: number | null
  completedAt?: number | null
  archivedAt?: number | null
  attempts?: number
  maxAttempts?: number
  retryBackoffSec?: number
  retryScheduledAt?: number | null
  runNumber?: number
  totalRuns?: number
  totalCompleted?: number
  totalFailed?: number
  sourceType?: 'schedule' | 'delegation' | 'manual' | 'import'
  sourceScheduleId?: string | null
  sourceScheduleName?: string | null
  sourceScheduleKey?: string | null
  externalSource?: {
    source: string
    id?: string | null
    repo?: string | null
    number?: number | null
    state?: string | null
    labels?: string[]
    assignee?: string | null
    url?: string | null
  } | null
  lastActivityAt?: number | null
  deferredReason?: string | null
  deadLetteredAt?: number | null
  cliResumeId?: string | null
  cliProvider?: string | null
  claudeResumeId?: string | null
  codexResumeId?: string | null
  opencodeResumeId?: string | null
  geminiResumeId?: string | null
  checkpoint?: {
    lastRunId?: string | null
    lastSessionId?: string | null
    note?: string | null
    updatedAt: number
  } | null
  validation?: {
    ok: boolean
    reasons: string[]
    checkedAt: number
  } | null
  // Parent/child task hierarchy (user-created subtasks)
  parentTaskId?: string | null
  subtaskIds?: string[]
  // Task dependencies (DAG)
  blockedBy?: string[]
  blocks?: string[]
  // Task tags
  tags?: string[]
  // Due date
  dueAt?: number | null
  // Custom fields
  customFields?: Record<string, string | number | boolean>
  // Priority
  priority?: 'low' | 'medium' | 'high' | 'critical'
  // Dedup fingerprint
  fingerprint?: string
  qualityGate?: TaskQualityGateConfig | null
  executionPolicy?: TaskExecutionPolicy | null
  executionPolicyState?: TaskExecutionPolicyState | null
  workflow?: TaskWorkflowContext | null
  // Competitive task claiming (pool mode)
  assignmentMode?: 'direct' | 'pool'
  poolCandidateAgentIds?: string[]
  claimedByAgentId?: string | null
  claimedAt?: number | null
  requiredCapabilities?: string[]
  // Upstream task results (populated by cascadeUnblock when dependencies complete)
  upstreamResults?: Array<{
    taskId: string
    taskTitle: string
    agentId: string | null
    resultPreview: string | null
  }>
  repairRunId?: string | null
  lastRepairAttemptAt?: number | null
  // Atomic checkout — prevents two runners from starting the same task
  checkoutRunId?: string | null
  /** Cost attribution tags rolled up by /api/cost/by-code. */
  billingCodes?: string[]
  /** Customizable workflow state (separate from `status` lifecycle). */
  workflowStateId?: string | null
}

export type TaskHandoffCheckStatus = 'ok' | 'warning' | 'blocked'
export type TaskHandoffReadinessStatus = 'ready' | 'needs_attention' | 'blocked'

export interface TaskHandoffTaskRef {
  id: string
  title: string
  status: BoardTaskStatus
  agentId?: string | null
  completedAt?: number | null
  liveness?: TaskLivenessSnapshot | null
}

export interface TaskHandoffCheck {
  id: string
  label: string
  status: TaskHandoffCheckStatus
  detail?: string | null
  taskIds?: string[]
}

export interface TaskHandoffRunSummary {
  runId: string
  sessionId: string
  title: string
  status: string
  result: string | null
  error: string | null
  warnings: string[]
  evidenceCount: number
}

export interface TaskHandoffPacket {
  schemaVersion: 1
  taskId: string
  title: string
  description?: string | null
  objective?: string | null
  status: BoardTaskStatus
  priority?: BoardTask['priority']
  generatedAt: number
  updatedAt: number
  owner: {
    agentId: string | null
    projectId?: string | null
    sessionId?: string | null
    createdByAgentId?: string | null
    delegatedByAgentId?: string | null
  }
  liveness: TaskLivenessSnapshot
  execution: {
    workspacePath?: string | null
    sourceCwd?: string | null
    mode?: TaskExecutionWorkspaceMode | null
    contextPath?: string | null
    envPath?: string | null
    previewLinks: TaskPreviewLink[]
    runtimeServices: TaskRuntimeService[]
  }
  dependencies: {
    blockedBy: TaskHandoffTaskRef[]
    blocks: TaskHandoffTaskRef[]
  }
  qualityGate: {
    enabled: boolean
    config: TaskQualityGateConfig | null
    checks: TaskHandoffCheck[]
  }
  executionPolicy: {
    enabled: boolean
    config: TaskExecutionPolicy | null
    state: TaskExecutionPolicyState | null
    checks: TaskHandoffCheck[]
  }
  outputs: {
    result?: string | null
    error?: string | null
    outputFiles: string[]
    artifacts: NonNullable<BoardTask['artifacts']>
    completionReportPath?: string | null
    verificationSummary?: string | null
  }
  resume: {
    cliProvider?: string | null
    cliResumeId?: string | null
    claudeResumeId?: string | null
    codexResumeId?: string | null
    opencodeResumeId?: string | null
    geminiResumeId?: string | null
  }
  run: TaskHandoffRunSummary | null
  readiness: {
    status: TaskHandoffReadinessStatus
    checks: TaskHandoffCheck[]
    recommendedActions: string[]
  }
}
