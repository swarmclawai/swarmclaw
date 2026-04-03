import type { MessageToolEvent } from './message'
import type { KnowledgeCitation, KnowledgeRetrievalTrace } from './misc'

// --- Structured Session Runs / Protocols ---

export type ProtocolRunStatus = 'draft' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'archived'

export type ProtocolPhaseKind =
  | 'present'
  | 'collect_independent_inputs'
  | 'round_robin'
  | 'compare'
  | 'decide'
  | 'summarize'
  | 'emit_tasks'
  | 'wait'
  | 'dispatch_task'
  | 'dispatch_delegation'
  | 'a2a_delegate'

export interface ProtocolPhaseDefinition {
  id: string
  kind: ProtocolPhaseKind
  label: string
  instructions?: string | null
  turnLimit?: number | null
  completionCriteria?: string | null
  taskConfig?: { agentId?: string; title: string; description: string } | null
  delegationConfig?: { agentId: string; message: string } | null
  a2aDelegateConfig?: {
    targetUrl?: string | null
    targetExternalAgentId?: string | null
    taskName: string
    taskMessage: string
    timeoutMs?: number | null
    credentialId?: string | null
    onFailure?: 'fail' | 'advance_with_warning'
  } | null
}

export type ProtocolConditionDefinition =
  | { type: 'summary_exists' }
  | { type: 'artifact_exists'; artifactKind?: ProtocolRunArtifact['kind'] | null }
  | { type: 'artifact_count_at_least'; count: number; artifactKind?: ProtocolRunArtifact['kind'] | null }
  | { type: 'created_task_count_at_least'; count: number }
  | { type: 'all'; conditions: ProtocolConditionDefinition[] }
  | { type: 'any'; conditions: ProtocolConditionDefinition[] }

export interface ProtocolBranchCase {
  id: string
  label: string
  nextStepId: string
  description?: string | null
  when?: ProtocolConditionDefinition | null
}

export interface ProtocolRepeatConfig {
  bodyStepId: string
  nextStepId?: string | null
  maxIterations: number
  exitCondition?: ProtocolConditionDefinition | null
  onExhausted?: 'advance' | 'fail'
}

export interface ProtocolParallelBranchDefinition {
  id: string
  label: string
  steps: ProtocolStepDefinition[]
  entryStepId?: string | null
  participantAgentIds?: string[]
  facilitatorAgentId?: string | null
  observerAgentIds?: string[]
}

export interface ProtocolParallelConfig {
  branches: ProtocolParallelBranchDefinition[]
}

export interface ProtocolJoinConfig {
  parallelStepId?: string | null
}

export type ProtocolStepKind =
  | ProtocolPhaseKind
  | 'branch'
  | 'repeat'
  | 'parallel'
  | 'join'
  | 'complete'
  | 'for_each'
  | 'subflow'
  | 'swarm_claim'

export interface ProtocolStepDefinition {
  id: string
  kind: ProtocolStepKind
  label: string
  instructions?: string | null
  turnLimit?: number | null
  completionCriteria?: string | null
  taskConfig?: { agentId?: string; title: string; description: string } | null
  delegationConfig?: { agentId: string; message: string } | null
  a2aDelegateConfig?: {
    targetUrl?: string | null
    targetExternalAgentId?: string | null
    taskName: string
    taskMessage: string
    timeoutMs?: number | null
    credentialId?: string | null
    onFailure?: 'fail' | 'advance_with_warning'
  } | null
  nextStepId?: string | null
  branchCases?: ProtocolBranchCase[]
  defaultNextStepId?: string | null
  repeat?: ProtocolRepeatConfig | null
  parallel?: ProtocolParallelConfig | null
  join?: ProtocolJoinConfig | null
  dependsOnStepIds?: string[]
  outputKey?: string | null
  forEach?: ProtocolForEachConfig | null
  subflow?: ProtocolSubflowConfig | null
  swarm?: ProtocolSwarmConfig | null
}

export interface ProtocolTemplate {
  id: string
  name: string
  description: string
  builtIn: boolean
  singleAgentAllowed?: boolean
  tags?: string[]
  recommendedOutputs?: string[]
  defaultPhases: ProtocolPhaseDefinition[]
  steps?: ProtocolStepDefinition[]
  entryStepId?: string | null
  createdAt?: number
  updatedAt?: number
}

export type ProtocolSourceRef =
  | { kind: 'manual' }
  | { kind: 'api' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'chatroom'; chatroomId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'protocol_run'; runId: string; parentRunId?: string | null; stepId?: string | null; branchId?: string | null }

export interface ProtocolRunArtifact {
  id: string
  kind: 'summary' | 'decision' | 'comparison' | 'notes' | 'action_items'
  title: string
  content: string
  phaseId?: string | null
  taskIds?: string[]
  createdAt: number
}

export interface ProtocolRunPhaseStateResponse {
  agentId: string
  text: string
  toolEvents?: MessageToolEvent[]
  citations?: KnowledgeCitation[]
  retrievalTrace?: KnowledgeRetrievalTrace | null
}

export interface ProtocolRunPhaseState {
  phaseId: string
  respondedAgentIds?: string[]
  responses?: ProtocolRunPhaseStateResponse[]
  appendedToTranscript?: boolean
  artifactId?: string | null
  dispatchedTaskId?: string | null
}

export interface ProtocolRunLoopState {
  stepId: string
  iterationCount: number
}

export interface ProtocolRunBranchDecision {
  stepId: string
  caseId?: string | null
  nextStepId?: string | null
  decidedAt: number
}

export interface ProtocolRunParallelBranchState {
  branchId: string
  label: string
  runId: string
  status: ProtocolRunStatus
  participantAgentIds?: string[]
  summary?: string | null
  lastError?: string | null
  updatedAt: number
}

export interface ProtocolRunParallelStepState {
  stepId: string
  branchRunIds: string[]
  branches: ProtocolRunParallelBranchState[]
  waitingOnBranchIds?: string[]
  joinReady?: boolean
  joinCompletedAt?: number | null
}

// --- DAG Step State ---

export type ProtocolRunStepStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped'

export interface ProtocolRunStepState {
  stepId: string
  status: ProtocolRunStepStatus
  startedAt?: number | null
  completedAt?: number | null
  error?: string | null
}

export interface ProtocolRunStepOutput {
  stepId: string
  outputKey?: string | null
  summary?: string | null
  artifactIds?: string[]
  taskIds?: string[]
  childRunIds?: string[]
  structuredData?: Record<string, unknown> | null
}

// --- For-Each Config ---

export interface ProtocolForEachConfig {
  itemsSource:
    | { type: 'literal'; items: unknown[] }
    | { type: 'step_output'; stepId: string; path?: string | null }
    | { type: 'artifact'; artifactId?: string | null; artifactKind?: string | null }
    | { type: 'llm_extract'; prompt: string }
  itemAlias: string
  branchTemplate: {
    steps: ProtocolStepDefinition[]
    entryStepId?: string | null
    participantAgentIds?: string[]
    facilitatorAgentId?: string | null
  }
  joinMode: 'all'
  maxItems?: number | null
  onEmpty?: 'fail' | 'skip' | 'advance'
}

export interface ProtocolRunForEachStepState {
  stepId: string
  items: unknown[]
  branchRunIds: string[]
  branches: ProtocolRunParallelBranchState[]
  waitingOnBranchIds?: string[]
  joinReady?: boolean
  joinCompletedAt?: number | null
}

// --- Subflow Config ---

export interface ProtocolSubflowConfig {
  templateId: string
  templateVersion?: string | null
  participantAgentIds?: string[]
  facilitatorAgentId?: string | null
  inputMapping?: Record<string, string> | null
  outputMapping?: Record<string, string> | null
  onFailure: 'fail_parent' | 'advance_with_warning'
}

export interface ProtocolRunSubflowState {
  stepId: string
  childRunId: string
  templateId: string
  status: ProtocolRunStatus
  summary?: string | null
  lastError?: string | null
  startedAt?: number | null
  completedAt?: number | null
}

// --- Swarm Config ---

export interface ProtocolSwarmConfig {
  eligibleAgentIds: string[]
  workItemsSource:
    | { type: 'literal'; items: Array<{ id: string; label: string; description?: string | null }> }
    | { type: 'step_output'; stepId: string; path?: string | null }
  claimLimitPerAgent?: number | null
  selectionMode: 'first_claim' | 'claim_until_empty'
  claimTimeoutSec: number
  onUnclaimed: 'fail' | 'advance' | 'fallback_assign'
}

export interface ProtocolSwarmClaim {
  id: string
  workItemId: string
  workItemLabel: string
  agentId: string
  childRunId?: string | null
  taskId?: string | null
  status: 'claimed' | 'running' | 'completed' | 'failed'
  claimedAt: number
  completedAt?: number | null
}

export interface ProtocolRunSwarmState {
  stepId: string
  workItems: Array<{ id: string; label: string; description?: string | null }>
  claims: ProtocolSwarmClaim[]
  unclaimedItemIds: string[]
  eligibleAgentIds: string[]
  claimLimitPerAgent: number
  selectionMode: 'first_claim' | 'claim_until_empty'
  claimTimeoutSec: number
  openedAt: number
  closedAt?: number | null
  timedOut?: boolean
}

export interface ProtocolRunConfig {
  goal?: string | null
  kickoffMessage?: string | null
  roundLimit?: number | null
  decisionMode?: string | null
  createTranscript?: boolean
  autoEmitTasks?: boolean
  taskProjectId?: string | null
  postSummaryToParent?: boolean
}

export interface ProtocolRun {
  id: string
  title: string
  templateId: string
  templateName: string
  status: ProtocolRunStatus
  sourceRef: ProtocolSourceRef
  participantAgentIds: string[]
  facilitatorAgentId?: string | null
  observerAgentIds?: string[]
  taskId?: string | null
  sessionId?: string | null
  parentRunId?: string | null
  parentStepId?: string | null
  branchId?: string | null
  parentChatroomId?: string | null
  transcriptChatroomId?: string | null
  scheduleId?: string | null
  systemOwned?: boolean
  phases: ProtocolPhaseDefinition[]
  steps?: ProtocolStepDefinition[]
  entryStepId?: string | null
  currentStepId?: string | null
  config?: ProtocolRunConfig | null
  currentPhaseIndex: number
  roundNumber?: number
  summary?: string | null
  latestArtifactId?: string | null
  artifacts?: ProtocolRunArtifact[]
  createdTaskIds?: string[]
  waitingReason?: string | null
  pauseReason?: string | null
  lastError?: string | null
  operatorContext?: string[]
  phaseState?: ProtocolRunPhaseState | null
  loopState?: Record<string, ProtocolRunLoopState>
  branchHistory?: ProtocolRunBranchDecision[]
  parallelState?: Record<string, ProtocolRunParallelStepState>
  stepState?: Record<string, ProtocolRunStepState>
  completedStepIds?: string[]
  runningStepIds?: string[]
  readyStepIds?: string[]
  failedStepIds?: string[]
  stepOutputs?: Record<string, ProtocolRunStepOutput>
  forEachState?: Record<string, ProtocolRunForEachStepState>
  subflowState?: Record<string, ProtocolRunSubflowState>
  swarmState?: Record<string, ProtocolRunSwarmState>
  createdAt: number
  updatedAt: number
  startedAt?: number | null
  endedAt?: number | null
  archivedAt?: number | null
}

export interface ProtocolRunEvent {
  id: string
  runId: string
  type:
    | 'created'
    | 'phase_started'
    | 'phase_completed'
    | 'participant_response'
    | 'artifact_emitted'
    | 'task_emitted'
    | 'waiting'
    | 'paused'
    | 'resumed'
    | 'phase_skipped'
    | 'phase_retried'
    | 'context_injected'
    | 'recovered'
    | 'step_started'
    | 'step_completed'
    | 'branch_taken'
    | 'parallel_started'
    | 'parallel_branch_spawned'
    | 'parallel_branch_completed'
    | 'parallel_branch_failed'
    | 'join_ready'
    | 'join_completed'
    | 'loop_iteration_started'
    | 'loop_iteration_completed'
    | 'loop_exhausted'
    | 'completed'
    | 'failed'
    | 'warning'
    | 'cancelled'
    | 'task_dispatched'
    | 'delegation_dispatched'
    | 'archived'
    | 'summary_posted'
    | 'step_ready'
    | 'step_waiting'
    | 'step_failed'
    | 'for_each_expanded'
    | 'subflow_started'
    | 'subflow_completed'
    | 'subflow_failed'
    | 'swarm_opened'
    | 'swarm_claimed'
    | 'swarm_exhausted'
  summary: string
  phaseId?: string | null
  stepId?: string | null
  agentId?: string | null
  artifactId?: string | null
  taskId?: string | null
  createdAt: number
  data?: Record<string, unknown> | null
  citations?: KnowledgeCitation[]
}
