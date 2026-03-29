import { z } from 'zod'

import { genId } from '@/lib/id'
import { cleanText, cleanMultiline, normalizeList } from '@/lib/server/text-normalization'
import type {
  EvidenceRef,
  SessionWorkingState,
  WorkingArtifact,
  WorkingArtifactPatch,
  WorkingBlocker,
  WorkingBlockerPatch,
  WorkingDecision,
  WorkingDecisionPatch,
  WorkingFact,
  WorkingFactPatch,
  WorkingHypothesis,
  WorkingHypothesisPatch,
  WorkingPlanStep,
  WorkingPlanStepPatch,
  WorkingQuestion,
  WorkingQuestionPatch,
  WorkingStateItemStatus,
  WorkingStateStatus,
} from '@/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PLAN_STEPS = 12
export const MAX_CONFIRMED_FACTS = 20
export const MAX_ARTIFACTS = 20
export const MAX_DECISIONS = 12
export const MAX_BLOCKERS = 8
export const MAX_OPEN_QUESTIONS = 8
export const MAX_HYPOTHESES = 8
export const MAX_EVIDENCE_REFS = 40
export const EXTRACTION_TIMEOUT_MS = 7_500

export const ACTIVE_STATUS: WorkingStateItemStatus = 'active'

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const WorkingItemStatusSchema = z.enum(['active', 'resolved', 'superseded'])
const WorkingStateStatusSchema = z.enum(['idle', 'progress', 'blocked', 'waiting', 'completed'])

export const WorkingPlanStepPatchSchema = z.object({
  id: z.string().optional().nullable(),
  text: z.string().optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
})

export const WorkingFactPatchSchema = z.object({
  id: z.string().optional().nullable(),
  statement: z.string().optional().nullable(),
  source: z.enum(['user', 'tool', 'assistant', 'system']).optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
  evidenceIds: z.array(z.string()).optional().nullable(),
})

export const WorkingArtifactPatchSchema = z.object({
  id: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  kind: z.enum(['file', 'url', 'approval', 'message', 'other']).optional().nullable(),
  path: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  sourceTool: z.string().optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
  evidenceIds: z.array(z.string()).optional().nullable(),
})

export const WorkingDecisionPatchSchema = z.object({
  id: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  rationale: z.string().optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
  evidenceIds: z.array(z.string()).optional().nullable(),
})

export const WorkingBlockerPatchSchema = z.object({
  id: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  kind: z.enum(['approval', 'credential', 'human_input', 'external_dependency', 'error', 'other']).optional().nullable(),
  nextAction: z.string().optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
  evidenceIds: z.array(z.string()).optional().nullable(),
})

export const WorkingQuestionPatchSchema = z.object({
  id: z.string().optional().nullable(),
  question: z.string().optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
  evidenceIds: z.array(z.string()).optional().nullable(),
})

export const WorkingHypothesisPatchSchema = z.object({
  id: z.string().optional().nullable(),
  statement: z.string().optional().nullable(),
  confidence: z.enum(['low', 'medium', 'high']).optional().nullable(),
  status: WorkingItemStatusSchema.optional().nullable(),
  evidenceIds: z.array(z.string()).optional().nullable(),
})

export const WorkingStatePatchSchema = z.object({
  objective: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  constraints: z.array(z.string()).optional().nullable(),
  successCriteria: z.array(z.string()).optional().nullable(),
  status: WorkingStateStatusSchema.optional().nullable(),
  nextAction: z.string().optional().nullable(),
  planSteps: z.array(WorkingPlanStepPatchSchema).optional().nullable(),
  factsUpsert: z.array(WorkingFactPatchSchema).optional().nullable(),
  artifactsUpsert: z.array(WorkingArtifactPatchSchema).optional().nullable(),
  decisionsAppend: z.array(WorkingDecisionPatchSchema).optional().nullable(),
  blockersUpsert: z.array(WorkingBlockerPatchSchema).optional().nullable(),
  questionsUpsert: z.array(WorkingQuestionPatchSchema).optional().nullable(),
  hypothesesUpsert: z.array(WorkingHypothesisPatchSchema).optional().nullable(),
  supersedeIds: z.array(z.string()).optional().nullable(),
}).passthrough()

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

export type TimedWorkingItem = {
  id: string
  status: WorkingStateItemStatus
  createdAt: number
  updatedAt: number
}

export type UpsertConfig<TItem extends TimedWorkingItem, TPatch> = {
  max: number
  getPatchId: (patch: TPatch) => string | null
  getPatchKey: (patch: TPatch) => string
  getItemKey: (item: TItem) => string
  create: (patch: TPatch, nowTs: number) => TItem
  merge: (current: TItem, patch: TPatch, nowTs: number) => TItem
  compact?: (items: TItem[], max: number) => TItem[]
}

// ---------------------------------------------------------------------------
// Exported input interfaces
// ---------------------------------------------------------------------------

import type { MessageToolEvent } from '@/types'

export interface WorkingStateDeterministicUpdateInput {
  sessionId: string
  message?: string | null
  assistantText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  runId?: string | null
  source?: string | null
}

export interface WorkingStateExtractionInput extends WorkingStateDeterministicUpdateInput {
  agentId?: string | null
  currentState?: SessionWorkingState | null
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional type alias preserved from original service.ts
export interface SynchronizeWorkingStateForTurnInput extends WorkingStateExtractionInput {}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function now(): number {
  return Date.now()
}

export function itemSortRank(status: WorkingStateItemStatus): number {
  if (status === 'active') return 0
  if (status === 'resolved') return 1
  return 2
}

export function genericCompact<TItem extends TimedWorkingItem>(items: TItem[], max: number): TItem[] {
  return [...items]
    .sort((left, right) => {
      const rankDelta = itemSortRank(left.status) - itemSortRank(right.status)
      if (rankDelta !== 0) return rankDelta
      return (right.updatedAt || 0) - (left.updatedAt || 0)
    })
    .slice(0, max)
}

export function compactPlanSteps(items: WorkingPlanStep[], max: number): WorkingPlanStep[] {
  if (items.length <= max) return items
  const next = [...items]
  while (next.length > max) {
    const removableIndex = next.findIndex((step) => step.status !== 'active')
    if (removableIndex >= 0) {
      next.splice(removableIndex, 1)
      continue
    }
    next.shift()
  }
  return next
}

// ---------------------------------------------------------------------------
// Normalize functions
// ---------------------------------------------------------------------------

export function normalizeItemStatus(value: unknown, fallback: WorkingStateItemStatus = ACTIVE_STATUS): WorkingStateItemStatus {
  return value === 'active' || value === 'resolved' || value === 'superseded'
    ? value
    : fallback
}

export function normalizeStateStatus(value: unknown, fallback: WorkingStateStatus = 'idle'): WorkingStateStatus {
  return value === 'idle' || value === 'progress' || value === 'blocked' || value === 'waiting' || value === 'completed'
    ? value
    : fallback
}

export function normalizeEvidenceIds(input: unknown): string[] | undefined {
  const cleaned = normalizeList(input, 12, 120)
  return cleaned.length > 0 ? cleaned : undefined
}

export function normalizeEvidenceRef(input: unknown): EvidenceRef | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const summary = cleanText(record.summary, 280)
  if (!summary) return null
  const type = record.type === 'tool'
    || record.type === 'message'
    || record.type === 'task'
    || record.type === 'artifact'
    || record.type === 'error'
    || record.type === 'approval'
    ? record.type
    : 'message'
  return {
    id: cleanText(record.id, 120) || genId(12),
    type,
    summary,
    value: cleanText(record.value, 240) || null,
    toolName: cleanText(record.toolName, 120) || null,
    toolCallId: cleanText(record.toolCallId, 120) || null,
    runId: cleanText(record.runId, 120) || null,
    sessionId: cleanText(record.sessionId, 120) || null,
    taskId: cleanText(record.taskId, 120) || null,
    createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? Math.trunc(record.createdAt)
      : now(),
  }
}

export function normalizePlanStep(input: unknown): WorkingPlanStep | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const text = cleanText(record.text, 240)
  if (!text) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    text,
    status: normalizeItemStatus(record.status),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeFact(input: unknown): WorkingFact | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const statement = cleanText(record.statement, 280)
  if (!statement) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    statement,
    source: record.source === 'user'
      || record.source === 'tool'
      || record.source === 'assistant'
      || record.source === 'system'
      ? record.source
      : 'assistant',
    status: normalizeItemStatus(record.status),
    evidenceIds: normalizeEvidenceIds(record.evidenceIds),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeArtifact(input: unknown): WorkingArtifact | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const label = cleanText(record.label, 240)
  if (!label) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    label,
    kind: record.kind === 'file'
      || record.kind === 'url'
      || record.kind === 'approval'
      || record.kind === 'message'
      || record.kind === 'other'
      ? record.kind
      : 'other',
    path: cleanText(record.path, 320) || null,
    url: cleanText(record.url, 320) || null,
    sourceTool: cleanText(record.sourceTool, 120) || null,
    status: normalizeItemStatus(record.status),
    evidenceIds: normalizeEvidenceIds(record.evidenceIds),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeDecision(input: unknown): WorkingDecision | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const summary = cleanText(record.summary, 280)
  if (!summary) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    summary,
    rationale: cleanText(record.rationale, 320) || null,
    status: normalizeItemStatus(record.status),
    evidenceIds: normalizeEvidenceIds(record.evidenceIds),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeBlocker(input: unknown): WorkingBlocker | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const summary = cleanText(record.summary, 280)
  if (!summary) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    summary,
    kind: record.kind === 'approval'
      || record.kind === 'credential'
      || record.kind === 'human_input'
      || record.kind === 'external_dependency'
      || record.kind === 'error'
      || record.kind === 'other'
      ? record.kind
      : null,
    nextAction: cleanText(record.nextAction, 240) || null,
    status: normalizeItemStatus(record.status),
    evidenceIds: normalizeEvidenceIds(record.evidenceIds),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeQuestion(input: unknown): WorkingQuestion | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const question = cleanText(record.question, 280)
  if (!question) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    question,
    status: normalizeItemStatus(record.status),
    evidenceIds: normalizeEvidenceIds(record.evidenceIds),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeHypothesis(input: unknown): WorkingHypothesis | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const statement = cleanText(record.statement, 280)
  if (!statement) return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : now()
  return {
    id: cleanText(record.id, 120) || genId(12),
    statement,
    confidence: record.confidence === 'low' || record.confidence === 'medium' || record.confidence === 'high'
      ? record.confidence
      : null,
    status: normalizeItemStatus(record.status),
    evidenceIds: normalizeEvidenceIds(record.evidenceIds),
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
  }
}

export function normalizeMatchKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// defaultWorkingState & normalizeWorkingState
// ---------------------------------------------------------------------------

export function defaultWorkingState(sessionId: string): SessionWorkingState {
  const nowTs = now()
  return {
    sessionId,
    objective: null,
    summary: null,
    constraints: [],
    successCriteria: [],
    status: 'idle',
    nextAction: null,
    planSteps: [],
    confirmedFacts: [],
    artifacts: [],
    decisions: [],
    blockers: [],
    openQuestions: [],
    hypotheses: [],
    evidenceRefs: [],
    createdAt: nowTs,
    updatedAt: nowTs,
    lastCompactedAt: null,
  }
}

export function normalizeWorkingState(
  input: unknown,
  sessionId: string,
): SessionWorkingState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaultWorkingState(sessionId)
  }
  const record = input as Record<string, unknown>
  const base = defaultWorkingState(sessionId)
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? Math.trunc(record.createdAt)
    : base.createdAt
  const normalized: SessionWorkingState = {
    sessionId: cleanText(record.sessionId, 120) || sessionId,
    objective: cleanMultiline(record.objective, 900) || base.objective,
    summary: cleanMultiline(record.summary, 600) || base.summary,
    constraints: normalizeList(record.constraints, 12, 240),
    successCriteria: normalizeList(record.successCriteria, 12, 240),
    status: normalizeStateStatus(record.status, base.status),
    nextAction: cleanText(record.nextAction, 240) || base.nextAction,
    planSteps: (Array.isArray(record.planSteps) ? record.planSteps.map(normalizePlanStep).filter(Boolean) : []) as WorkingPlanStep[],
    confirmedFacts: (Array.isArray(record.confirmedFacts) ? record.confirmedFacts.map(normalizeFact).filter(Boolean) : []) as WorkingFact[],
    artifacts: (Array.isArray(record.artifacts) ? record.artifacts.map(normalizeArtifact).filter(Boolean) : []) as WorkingArtifact[],
    decisions: (Array.isArray(record.decisions) ? record.decisions.map(normalizeDecision).filter(Boolean) : []) as WorkingDecision[],
    blockers: (Array.isArray(record.blockers) ? record.blockers.map(normalizeBlocker).filter(Boolean) : []) as WorkingBlocker[],
    openQuestions: (Array.isArray(record.openQuestions) ? record.openQuestions.map(normalizeQuestion).filter(Boolean) : []) as WorkingQuestion[],
    hypotheses: (Array.isArray(record.hypotheses) ? record.hypotheses.map(normalizeHypothesis).filter(Boolean) : []) as WorkingHypothesis[],
    evidenceRefs: (Array.isArray(record.evidenceRefs) ? record.evidenceRefs.map(normalizeEvidenceRef).filter(Boolean) : []) as EvidenceRef[],
    createdAt,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : createdAt,
    lastCompactedAt: typeof record.lastCompactedAt === 'number' && Number.isFinite(record.lastCompactedAt)
      ? Math.trunc(record.lastCompactedAt)
      : null,
  }
  return compactWorkingStateObject(normalized)
}

// ---------------------------------------------------------------------------
// compactWorkingStateObject
// ---------------------------------------------------------------------------

export function compactWorkingStateObject(state: SessionWorkingState): SessionWorkingState {
  return {
    ...state,
    planSteps: compactPlanSteps(state.planSteps, MAX_PLAN_STEPS),
    confirmedFacts: genericCompact(state.confirmedFacts, MAX_CONFIRMED_FACTS),
    artifacts: genericCompact(state.artifacts, MAX_ARTIFACTS),
    decisions: genericCompact(state.decisions, MAX_DECISIONS),
    blockers: genericCompact(state.blockers, MAX_BLOCKERS),
    openQuestions: genericCompact(state.openQuestions, MAX_OPEN_QUESTIONS),
    hypotheses: genericCompact(state.hypotheses, MAX_HYPOTHESES),
    evidenceRefs: [...state.evidenceRefs]
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      .slice(0, MAX_EVIDENCE_REFS),
    lastCompactedAt: now(),
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// upsertItems & upsertConfig factories
// ---------------------------------------------------------------------------

export function upsertItems<TItem extends TimedWorkingItem, TPatch>(
  items: TItem[],
  patches: TPatch[] | undefined,
  config: UpsertConfig<TItem, TPatch>,
): TItem[] {
  if (!Array.isArray(patches) || patches.length === 0) return items
  const next = [...items]
  const nowTs = now()
  for (const patch of patches) {
    const key = normalizeMatchKey(config.getPatchKey(patch))
    if (!key) continue
    const patchId = config.getPatchId(patch)
    const index = next.findIndex((item) => {
      if (patchId && item.id === patchId) return true
      return normalizeMatchKey(config.getItemKey(item)) === key
    })
    if (index >= 0) {
      next[index] = config.merge(next[index], patch, nowTs)
    } else {
      next.push(config.create(patch, nowTs))
    }
  }
  return (config.compact || genericCompact)(next, config.max)
}

export function factUpsertConfig(): UpsertConfig<WorkingFact, WorkingFactPatch> {
  return {
    max: MAX_CONFIRMED_FACTS,
    getPatchId: (patch) => cleanText(patch.id, 120) || null,
    getPatchKey: (patch) => cleanText(patch.statement, 280),
    getItemKey: (item) => item.statement,
    create: (patch, nowTs) => ({
      id: cleanText(patch.id, 120) || genId(12),
      statement: cleanText(patch.statement, 280),
      source: patch.source === 'user'
        || patch.source === 'tool'
        || patch.source === 'assistant'
        || patch.source === 'system'
        ? patch.source
        : 'assistant',
      status: normalizeItemStatus(patch.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds),
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    merge: (current, patch, nowTs) => ({
      ...current,
      statement: cleanText(patch.statement, 280) || current.statement,
      source: patch.source === 'user'
        || patch.source === 'tool'
        || patch.source === 'assistant'
        || patch.source === 'system'
        ? patch.source
        : current.source,
      status: normalizeItemStatus(patch.status, current.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds) || current.evidenceIds,
      updatedAt: nowTs,
    }),
  }
}

export function artifactUpsertConfig(): UpsertConfig<WorkingArtifact, WorkingArtifactPatch> {
  return {
    max: MAX_ARTIFACTS,
    getPatchId: (patch) => cleanText(patch.id, 120) || null,
    getPatchKey: (patch) => cleanText(patch.path || patch.url || patch.label, 320),
    getItemKey: (item) => cleanText(item.path || item.url || item.label, 320),
    create: (patch, nowTs) => ({
      id: cleanText(patch.id, 120) || genId(12),
      label: cleanText(patch.label, 240),
      kind: patch.kind === 'file'
        || patch.kind === 'url'
        || patch.kind === 'approval'
        || patch.kind === 'message'
        || patch.kind === 'other'
        ? patch.kind
        : 'other',
      path: cleanText(patch.path, 320) || null,
      url: cleanText(patch.url, 320) || null,
      sourceTool: cleanText(patch.sourceTool, 120) || null,
      status: normalizeItemStatus(patch.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds),
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    merge: (current, patch, nowTs) => ({
      ...current,
      label: cleanText(patch.label, 240) || current.label,
      kind: patch.kind === 'file'
        || patch.kind === 'url'
        || patch.kind === 'approval'
        || patch.kind === 'message'
        || patch.kind === 'other'
        ? patch.kind
        : current.kind,
      path: cleanText(patch.path, 320) || current.path,
      url: cleanText(patch.url, 320) || current.url,
      sourceTool: cleanText(patch.sourceTool, 120) || current.sourceTool,
      status: normalizeItemStatus(patch.status, current.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds) || current.evidenceIds,
      updatedAt: nowTs,
    }),
  }
}

export function decisionUpsertConfig(): UpsertConfig<WorkingDecision, WorkingDecisionPatch> {
  return {
    max: MAX_DECISIONS,
    getPatchId: (patch) => cleanText(patch.id, 120) || null,
    getPatchKey: (patch) => cleanText(patch.summary, 280),
    getItemKey: (item) => item.summary,
    create: (patch, nowTs) => ({
      id: cleanText(patch.id, 120) || genId(12),
      summary: cleanText(patch.summary, 280),
      rationale: cleanText(patch.rationale, 320) || null,
      status: normalizeItemStatus(patch.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds),
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    merge: (current, patch, nowTs) => ({
      ...current,
      summary: cleanText(patch.summary, 280) || current.summary,
      rationale: cleanText(patch.rationale, 320) || current.rationale,
      status: normalizeItemStatus(patch.status, current.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds) || current.evidenceIds,
      updatedAt: nowTs,
    }),
  }
}

export function blockerUpsertConfig(): UpsertConfig<WorkingBlocker, WorkingBlockerPatch> {
  return {
    max: MAX_BLOCKERS,
    getPatchId: (patch) => cleanText(patch.id, 120) || null,
    getPatchKey: (patch) => cleanText(patch.summary, 280),
    getItemKey: (item) => item.summary,
    create: (patch, nowTs) => ({
      id: cleanText(patch.id, 120) || genId(12),
      summary: cleanText(patch.summary, 280),
      kind: patch.kind || null,
      nextAction: cleanText(patch.nextAction, 240) || null,
      status: normalizeItemStatus(patch.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds),
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    merge: (current, patch, nowTs) => ({
      ...current,
      summary: cleanText(patch.summary, 280) || current.summary,
      kind: patch.kind || current.kind,
      nextAction: cleanText(patch.nextAction, 240) || current.nextAction,
      status: normalizeItemStatus(patch.status, current.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds) || current.evidenceIds,
      updatedAt: nowTs,
    }),
  }
}

export function questionUpsertConfig(): UpsertConfig<WorkingQuestion, WorkingQuestionPatch> {
  return {
    max: MAX_OPEN_QUESTIONS,
    getPatchId: (patch) => cleanText(patch.id, 120) || null,
    getPatchKey: (patch) => cleanText(patch.question, 280),
    getItemKey: (item) => item.question,
    create: (patch, nowTs) => ({
      id: cleanText(patch.id, 120) || genId(12),
      question: cleanText(patch.question, 280),
      status: normalizeItemStatus(patch.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds),
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    merge: (current, patch, nowTs) => ({
      ...current,
      question: cleanText(patch.question, 280) || current.question,
      status: normalizeItemStatus(patch.status, current.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds) || current.evidenceIds,
      updatedAt: nowTs,
    }),
  }
}

export function hypothesisUpsertConfig(): UpsertConfig<WorkingHypothesis, WorkingHypothesisPatch> {
  return {
    max: MAX_HYPOTHESES,
    getPatchId: (patch) => cleanText(patch.id, 120) || null,
    getPatchKey: (patch) => cleanText(patch.statement, 280),
    getItemKey: (item) => item.statement,
    create: (patch, nowTs) => ({
      id: cleanText(patch.id, 120) || genId(12),
      statement: cleanText(patch.statement, 280),
      confidence: patch.confidence === 'low' || patch.confidence === 'medium' || patch.confidence === 'high'
        ? patch.confidence
        : null,
      status: normalizeItemStatus(patch.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds),
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    merge: (current, patch, nowTs) => ({
      ...current,
      statement: cleanText(patch.statement, 280) || current.statement,
      confidence: patch.confidence === 'low' || patch.confidence === 'medium' || patch.confidence === 'high'
        ? patch.confidence
        : current.confidence,
      status: normalizeItemStatus(patch.status, current.status),
      evidenceIds: normalizeEvidenceIds(patch.evidenceIds) || current.evidenceIds,
      updatedAt: nowTs,
    }),
  }
}

// ---------------------------------------------------------------------------
// appendEvidenceRefs & markSuperseded
// ---------------------------------------------------------------------------

export function appendEvidenceRefs(current: EvidenceRef[], additions: EvidenceRef[] | undefined): EvidenceRef[] {
  if (!Array.isArray(additions) || additions.length === 0) return current
  const merged = [...current]
  for (const addition of additions) {
    const normalized = normalizeEvidenceRef(addition)
    if (!normalized) continue
    const matchIndex = merged.findIndex((entry) => {
      if (normalized.toolCallId && entry.toolCallId && entry.toolCallId === normalized.toolCallId) return true
      return entry.type === normalized.type
        && normalizeMatchKey(entry.summary) === normalizeMatchKey(normalized.summary)
        && normalizeMatchKey(entry.value || '') === normalizeMatchKey(normalized.value || '')
    })
    if (matchIndex >= 0) {
      merged[matchIndex] = {
        ...merged[matchIndex],
        ...normalized,
      }
    } else {
      merged.push(normalized)
    }
  }
  return merged
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    .slice(0, MAX_EVIDENCE_REFS)
}

export function markSuperseded<TItem extends TimedWorkingItem>(items: TItem[], ids: string[] | undefined): TItem[] {
  if (!Array.isArray(ids) || ids.length === 0) return items
  const idSet = new Set(ids.map((id) => cleanText(id, 120)).filter(Boolean))
  if (idSet.size === 0) return items
  const nowTs = now()
  return items.map((item) => (idSet.has(item.id)
    ? { ...item, status: 'superseded' as WorkingStateItemStatus, updatedAt: nowTs }
    : item))
}
