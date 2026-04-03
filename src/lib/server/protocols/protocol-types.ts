/**
 * Protocol types, interfaces, constants, and primitive utilities.
 * Groups G1 + G2 from protocol-service.ts
 */
import type {
  BoardTask,
  Chatroom,
  KnowledgeCitation,
  KnowledgeRetrievalTrace,
  MessageToolEvent,
  ProtocolBranchCase,
  ProtocolPhaseDefinition,
  ProtocolRepeatConfig,
  ProtocolRun,
  ProtocolRunArtifact,
  ProtocolRunConfig,
  ProtocolRunEvent,
  ProtocolSourceRef,
  ProtocolStepDefinition,
  ProtocolTemplate,
} from '@/types'

// ---- Module-level constants (lines 83-85) ----

export const PROTOCOL_LOCK_TTL_MS = 120_000
export const AGENT_TURN_TIMEOUT_MS = 90_000

// ---- Exported interfaces (G1) ----

export interface ProtocolRunDetail {
  run: ProtocolRun
  template: ProtocolTemplate | null
  transcript: Chatroom | null
  parentChatroom: Chatroom | null
  linkedTask: BoardTask | null
  events: ProtocolRunEvent[]
}

export interface CreateProtocolRunInput {
  title: string
  templateId?: string | null
  phases?: ProtocolPhaseDefinition[]
  steps?: ProtocolStepDefinition[]
  entryStepId?: string | null
  participantAgentIds: string[]
  facilitatorAgentId?: string | null
  observerAgentIds?: string[]
  missionId?: string | null
  taskId?: string | null
  sessionId?: string | null
  parentRunId?: string | null
  parentStepId?: string | null
  branchId?: string | null
  parentChatroomId?: string | null
  scheduleId?: string | null
  sourceRef?: ProtocolSourceRef | null
  autoStart?: boolean
  createTranscript?: boolean
  config?: ProtocolRunConfig | null
  systemOwned?: boolean
}

export interface UpsertProtocolTemplateInput {
  name: string
  description: string
  singleAgentAllowed?: boolean
  tags?: string[]
  recommendedOutputs?: string[]
  defaultPhases?: ProtocolPhaseDefinition[]
  steps?: ProtocolStepDefinition[]
  entryStepId?: string | null
}

export interface ProtocolAgentTurnResult {
  text: string
  toolEvents: MessageToolEvent[]
  citations?: KnowledgeCitation[]
  retrievalTrace?: KnowledgeRetrievalTrace | null
}

export interface ProtocolRunDeps {
  now?: () => number
  executeAgentTurn?: (params: {
    run: ProtocolRun
    phase: ProtocolPhaseDefinition
    agentId: string
    prompt: string
  }) => Promise<ProtocolAgentTurnResult>
  extractActionItems?: (params: {
    run: ProtocolRun
    phase: ProtocolPhaseDefinition
    artifact: ProtocolRunArtifact
  }) => Promise<Array<{ title: string; description?: string | null; agentId?: string | null }>>
  decideBranchCase?: (params: {
    run: ProtocolRun
    step: ProtocolStepDefinition
    cases: ProtocolBranchCase[]
  }) => Promise<{ caseId: string; nextStepId: string } | null>
  decideRepeatContinuation?: (params: {
    run: ProtocolRun
    step: ProtocolStepDefinition
    repeat: ProtocolRepeatConfig
    iterationCount: number
  }) => Promise<'continue' | 'exit' | null>
}

export interface ProtocolRunActionInput {
  action: 'start' | 'pause' | 'resume' | 'retry_phase' | 'skip_phase' | 'cancel' | 'archive' | 'inject_context' | 'claim_work'
  reason?: string | null
  phaseId?: string | null
  context?: string | null
  stepId?: string | null
  agentId?: string | null
  workItemId?: string | null
}

// ---- Primitive utilities (G2) ----

export function now(deps?: ProtocolRunDeps): number {
  return deps?.now ? deps.now() : Date.now()
}

import { cleanText } from '@/lib/server/text-normalization'

export { cleanText }

export function uniqueIds(values: unknown, maxItems = 64): string[] {
  const source = Array.isArray(values) ? values : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of source) {
    const normalized = cleanText(value, 96)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

export function isDiscussionStepKind(kind: ProtocolStepDefinition['kind'] | ProtocolPhaseDefinition['kind']): kind is ProtocolPhaseDefinition['kind'] {
  return [
    'present',
    'collect_independent_inputs',
    'round_robin',
    'compare',
    'decide',
    'summarize',
    'emit_tasks',
    'wait',
    'dispatch_task',
    'dispatch_delegation',
  ].includes(kind)
}
