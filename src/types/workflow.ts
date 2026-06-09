import type {
  BoardTask,
  TaskExecutionPolicy,
  TaskQualityGateConfig,
} from './task'
import type { ProtocolRun } from './protocol'

export type WorkflowGoalClass =
  | 'read_only_discovery'
  | 'implementation'
  | 'review'
  | 'migration'
  | 'bug_hunt'
  | 'research'
  | 'triage'
  | 'release_gate'

export type WorkflowContinuationState =
  | 'done'
  | 'waiting'
  | 'retry'
  | 'verify'
  | 'research'
  | 'implement'
  | 'checkpoint'
  | 'blocked'
  | 'needs_plan'

export interface WorkflowSafetyProfile {
  mode: 'read_only' | 'standard' | 'implementation' | 'release'
  approvalRequired?: boolean
  quarantine?: boolean
  allowedScopes?: string[]
  forbiddenActions?: string[]
  checkpointActions?: string[]
  maxActiveTasks?: number
  maxTotalTasks?: number
  maxIterations?: number
  maxRetries?: number
  maxElapsedMinutes?: number
}

export interface WorkflowBundleTaskSpec {
  key: string
  title: string
  description: string
  agentId: string
  cwd?: string | null
  projectId?: string | null
  qualityGate?: TaskQualityGateConfig | null
  executionPolicy?: TaskExecutionPolicy | null
  tags?: string[]
  priority?: BoardTask['priority']
  maxAttempts?: number
  retryBackoffSec?: number
  dependsOn?: string[]
  blocks?: string[]
  expectedMarker?: string | null
  allowedScope?: string[]
  forbiddenActions?: string[]
}

export interface WorkflowBundleSpec {
  title: string
  goal: string
  cwd?: string | null
  projectId?: string | null
  safetyProfile: WorkflowSafetyProfile
  tasks: WorkflowBundleTaskSpec[]
  queueImmediately?: boolean
  templateId?: string | null
}

export interface WorkflowBundleLaunchResult {
  run: ProtocolRun
  taskIds: string[]
  tasks: BoardTask[]
  queued: boolean
}

export interface WorkflowPlanRouting {
  classification: WorkflowGoalClass
  strategy: 'deterministic_bundle' | 'dynamic_draft'
  templateId: string
  reason: string
}

export interface WorkflowPlanApprovalGate {
  status: 'review_required'
  reviewerAgentId: string
  mode: 'operator_adversarial_review'
  requiredBeforeLaunch: true
  checklist: string[]
  rejectionTriggers: string[]
}

export interface WorkflowPlanQuarantine {
  enabled: boolean
  reason: string
  restrictedActions: string[]
}

export interface WorkflowPlanDraft {
  classification: WorkflowGoalClass
  summary: string
  bundle: WorkflowBundleSpec
  routing: WorkflowPlanRouting
  approvalGate: WorkflowPlanApprovalGate
  quarantine: WorkflowPlanQuarantine
  risks: string[]
  checkpoints: string[]
  verification: string[]
  createsTasks: false
}

export interface WorkflowLedgerEntry {
  runId: string
  taskId: string
  taskKey?: string | null
  title: string
  agentId: string
  status: BoardTask['status']
  marker?: string | null
  expectedMarker?: string | null
  allowedScope?: string[]
  forbiddenActions?: string[]
  filesChanged?: string[]
  verification?: string | null
  blockers?: string[]
  qaDisposition?: 'accepted' | 'blocked' | 'changes_requested' | 'unknown'
  resultPreview?: string | null
  updatedAt: number
}

export interface WorkflowLedger {
  runId: string
  runTitle: string
  status: ProtocolRun['status']
  entries: WorkflowLedgerEntry[]
  eventCount: number
  generatedAt: number
}

export interface WorkflowContinuationResult {
  runId: string
  state: WorkflowContinuationState
  summary: string
  nextAction: 'none' | 'wait' | 'draft_next_bundle' | 'retry_failed' | 'request_checkpoint'
  draft?: WorkflowPlanDraft | null
  ledger: WorkflowLedger
}
