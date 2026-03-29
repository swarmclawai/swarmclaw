
export type WorkingStateStatus = 'idle' | 'progress' | 'blocked' | 'waiting' | 'completed'
export type WorkingStateItemStatus = 'active' | 'resolved' | 'superseded'

export interface EvidenceRef {
  id: string
  type: 'tool' | 'message' | 'task' | 'artifact' | 'error' | 'approval'
  summary: string
  value?: string | null
  toolName?: string | null
  toolCallId?: string | null
  runId?: string | null
  sessionId?: string | null
  taskId?: string | null
  createdAt: number
}

export interface WorkingPlanStep {
  id: string
  text: string
  status: WorkingStateItemStatus
  createdAt: number
  updatedAt: number
}

export interface WorkingFact {
  id: string
  statement: string
  source: 'user' | 'tool' | 'assistant' | 'system'
  status: WorkingStateItemStatus
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkingArtifact {
  id: string
  label: string
  kind: 'file' | 'url' | 'approval' | 'message' | 'other'
  path?: string | null
  url?: string | null
  sourceTool?: string | null
  status: WorkingStateItemStatus
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkingDecision {
  id: string
  summary: string
  rationale?: string | null
  status: WorkingStateItemStatus
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkingBlocker {
  id: string
  summary: string
  kind?: 'approval' | 'credential' | 'human_input' | 'external_dependency' | 'error' | 'other' | null
  nextAction?: string | null
  status: WorkingStateItemStatus
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkingQuestion {
  id: string
  question: string
  status: WorkingStateItemStatus
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkingHypothesis {
  id: string
  statement: string
  confidence?: 'low' | 'medium' | 'high' | null
  status: WorkingStateItemStatus
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkingPlanStepPatch {
  id?: string | null
  text: string
  status?: WorkingStateItemStatus | null
}

export interface WorkingFactPatch {
  id?: string | null
  statement: string
  source?: WorkingFact['source'] | null
  status?: WorkingStateItemStatus | null
  evidenceIds?: string[]
}

export interface WorkingArtifactPatch {
  id?: string | null
  label: string
  kind?: WorkingArtifact['kind'] | null
  path?: string | null
  url?: string | null
  sourceTool?: string | null
  status?: WorkingStateItemStatus | null
  evidenceIds?: string[]
}

export interface WorkingDecisionPatch {
  id?: string | null
  summary: string
  rationale?: string | null
  status?: WorkingStateItemStatus | null
  evidenceIds?: string[]
}

export interface WorkingBlockerPatch {
  id?: string | null
  summary: string
  kind?: WorkingBlocker['kind']
  nextAction?: string | null
  status?: WorkingStateItemStatus | null
  evidenceIds?: string[]
}

export interface WorkingQuestionPatch {
  id?: string | null
  question: string
  status?: WorkingStateItemStatus | null
  evidenceIds?: string[]
}

export interface WorkingHypothesisPatch {
  id?: string | null
  statement: string
  confidence?: WorkingHypothesis['confidence']
  status?: WorkingStateItemStatus | null
  evidenceIds?: string[]
}

export interface WorkingStatePatch {
  objective?: string | null
  summary?: string | null
  constraints?: string[]
  successCriteria?: string[]
  status?: WorkingStateStatus | null
  nextAction?: string | null
  planSteps?: WorkingPlanStepPatch[]
  factsUpsert?: WorkingFactPatch[]
  artifactsUpsert?: WorkingArtifactPatch[]
  decisionsAppend?: WorkingDecisionPatch[]
  blockersUpsert?: WorkingBlockerPatch[]
  questionsUpsert?: WorkingQuestionPatch[]
  hypothesesUpsert?: WorkingHypothesisPatch[]
  evidenceAppend?: EvidenceRef[]
  supersedeIds?: string[]
}

export interface SessionWorkingState {
  sessionId: string
  objective?: string | null
  summary?: string | null
  constraints: string[]
  successCriteria: string[]
  status: WorkingStateStatus
  nextAction?: string | null
  planSteps: WorkingPlanStep[]
  confirmedFacts: WorkingFact[]
  artifacts: WorkingArtifact[]
  decisions: WorkingDecision[]
  blockers: WorkingBlocker[]
  openQuestions: WorkingQuestion[]
  hypotheses: WorkingHypothesis[]
  evidenceRefs: EvidenceRef[]
  createdAt: number
  updatedAt: number
  lastCompactedAt?: number | null
}

export interface ExecutionBriefPlanStep {
  text: string
  status: WorkingStateItemStatus
}

export interface ExecutionBrief {
  sessionId?: string | null
  objective: string | null
  summary: string | null
  status: WorkingStateStatus
  nextAction: string | null
  plan: ExecutionBriefPlanStep[]
  blockers: string[]
  facts: string[]
  artifacts: string[]
  constraints: string[]
  successCriteria: string[]
  evidenceRefs: EvidenceRef[]
  parentContext: string | null
}
