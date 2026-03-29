import type { SSEEvent } from './misc'

// --- Session Runs ---

export type SessionRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ExecutionKind =
  | 'session_turn'
  | 'task_attempt'
  | 'protocol_step'
  | 'heartbeat_tick'
  | 'schedule_wake'
  | 'repair_turn'
  | 'subagent_turn'

export type ExecutionOwnerType =
  | 'session'
  | 'task'
  | 'protocol_run'
  | 'schedule'
  | 'agent'
  | 'subagent'

export interface SessionRunHeartbeatConfig {
  ackMaxChars: number
  showOk: boolean
  showAlerts: boolean
  target: string | null
  deliveryMode?: 'default' | 'tool_only' | 'silent'
  lightContext?: boolean
}

export interface SessionRunRecoveryPayload {
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  internal: boolean
  source: string
  mode: string
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: SessionRunHeartbeatConfig
  replyToId?: string
  executionGroupKey?: string
}

export interface SessionRunRecord {
  id: string
  sessionId: string
  kind?: ExecutionKind
  ownerType?: ExecutionOwnerType | null
  ownerId?: string | null
  parentExecutionId?: string | null
  recoveryPolicy?: 'restart_recoverable' | 'ephemeral' | 'manual' | 'none'
  source: string
  internal: boolean
  mode: string
  status: SessionRunStatus
  messagePreview: string
  dedupeKey?: string
  queuedAt: number
  startedAt?: number
  endedAt?: number
  interruptedAt?: number
  interruptedReason?: string
  error?: string
  resultPreview?: string
  recoveredFromRestart?: boolean
  recoveredFromRunId?: string
  recoveryPayload?: SessionRunRecoveryPayload
  totalInputTokens?: number
  totalOutputTokens?: number
  estimatedCost?: number
}

export interface SessionQueuedTurn {
  runId: string
  sessionId: string
  text: string
  queuedAt: number
  position: number
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  replyToId?: string
  source?: string
}

export interface SessionQueueSnapshot {
  sessionId: string
  activeRunId: string | null
  activeTurn?: SessionQueuedTurn | null
  queueLength: number
  items: SessionQueuedTurn[]
}

export interface RunEventRecord {
  id: string
  runId: string
  sessionId: string
  kind?: ExecutionKind
  ownerType?: ExecutionOwnerType | null
  ownerId?: string | null
  parentExecutionId?: string | null
  timestamp: number
  phase: 'status' | 'event'
  status?: SessionRunStatus
  summary?: string
  event: SSEEvent
}

export type RuntimeFailureFamily =
  | 'provider_auth'
  | 'provider_transport'
  | 'gateway_disconnected'
  | 'browser_boot'
  | 'cli_missing'
  | 'rate_limit'
  | 'webhook_delivery'
  | 'connector_delivery'
  | 'workspace_recovery'

export type SupervisorIncidentKind =
  | 'run_error'
  | 'repeated_tool'
  | 'no_progress'
  | 'budget_pressure'
  | 'context_pressure'
  | 'runtime_failure'

export type SupervisorIncidentSeverity = 'low' | 'medium' | 'high'

export interface SupervisorIncident {
  id: string
  runId: string
  sessionId: string
  taskId?: string | null
  agentId?: string | null
  source: string
  kind: SupervisorIncidentKind
  severity: SupervisorIncidentSeverity
  summary: string
  details?: string | null
  toolName?: string | null
  failureFamily?: RuntimeFailureFamily | null
  remediation?: string | null
  repairPrompt?: string | null
  autoAction?: 'replan' | 'compact' | 'block' | 'budget_trim' | null
  createdAt: number
}

export interface RunReflection {
  id: string
  runId: string
  sessionId: string
  taskId?: string | null
  agentId?: string | null
  source: string
  status: SessionRunStatus | 'completed' | 'failed'
  summary: string
  sourceSnippet?: string | null
  invariantNotes: string[]
  derivedNotes: string[]
  failureNotes: string[]
  lessonNotes: string[]
  communicationNotes?: string[]
  relationshipNotes?: string[]
  significantEventNotes?: string[]
  profileNotes?: string[]
  boundaryNotes?: string[]
  openLoopNotes?: string[]
  incidentIds?: string[]
  autoMemoryIds?: string[]
  learnedSkillIds?: string[]
  learnedSkillNotes?: string[]
  qualityScore?: number | null
  qualityReasoning?: string | null
  createdAt: number
  updatedAt: number
}
