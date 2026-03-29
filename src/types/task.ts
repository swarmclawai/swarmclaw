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
  cwd?: string | null
  file?: string | null
  sessionId?: string | null
  completionReportPath?: string | null
  result?: string | null
  error?: string | null
  outputFiles?: string[]
  artifacts?: Array<{
    url: string
    type: 'image' | 'video' | 'pdf' | 'file'
    filename: string
  }>
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
}
