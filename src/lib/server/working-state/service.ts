import { genId } from '@/lib/id'
import { cleanText, cleanMultiline, normalizeList } from '@/lib/server/text-normalization'
import type {
  SessionWorkingState,
  WorkingBlocker,
  WorkingPlanStepPatch,
  WorkingStatePatch,
  WorkingStateItemStatus,
  WorkingStateStatus,
} from '@/types'

import {
  deletePersistedWorkingState,
  loadPersistedWorkingState,
  upsertPersistedWorkingState,
} from './repository'

import {
  normalizeWorkingState,
  defaultWorkingState,
  compactWorkingStateObject,
  normalizeItemStatus,
  normalizeStateStatus,
  upsertItems,
  factUpsertConfig,
  artifactUpsertConfig,
  decisionUpsertConfig,
  blockerUpsertConfig,
  questionUpsertConfig,
  hypothesisUpsertConfig,
  appendEvidenceRefs,
  markSuperseded,
  now,
  MAX_PLAN_STEPS,
  compactPlanSteps,
} from '@/lib/server/working-state/normalization'
import type {
  WorkingStateDeterministicUpdateInput,
  SynchronizeWorkingStateForTurnInput,
} from '@/lib/server/working-state/normalization'

import {
  deterministicEvidencePatch,
  extractWorkingStatePatch,
  shouldExtractStructuredPatch,
} from '@/lib/server/working-state/extraction'

import { buildWorkingStatePromptBlockFromState } from '@/lib/server/working-state/prompt'

// ---------------------------------------------------------------------------
// Re-exports for consumer compatibility
// ---------------------------------------------------------------------------

// normalization.ts re-exports
export {
  // Constants
  MAX_PLAN_STEPS,
  MAX_CONFIRMED_FACTS,
  MAX_ARTIFACTS,
  MAX_DECISIONS,
  MAX_BLOCKERS,
  MAX_OPEN_QUESTIONS,
  MAX_HYPOTHESES,
  MAX_EVIDENCE_REFS,
  EXTRACTION_TIMEOUT_MS,
  ACTIVE_STATUS,
  // Schemas
  WorkingPlanStepPatchSchema,
  WorkingFactPatchSchema,
  WorkingArtifactPatchSchema,
  WorkingDecisionPatchSchema,
  WorkingBlockerPatchSchema,
  WorkingQuestionPatchSchema,
  WorkingHypothesisPatchSchema,
  WorkingStatePatchSchema,
  // Normalize functions
  normalizeItemStatus,
  normalizeStateStatus,
  normalizeEvidenceIds,
  normalizeEvidenceRef,
  normalizePlanStep,
  normalizeFact,
  normalizeArtifact,
  normalizeDecision,
  normalizeBlocker,
  normalizeQuestion,
  normalizeHypothesis,
  normalizeWorkingState,
  normalizeMatchKey,
  // Utility helpers
  now,
  itemSortRank,
  genericCompact,
  compactPlanSteps,
  defaultWorkingState,
  compactWorkingStateObject,
  // Upsert
  upsertItems,
  factUpsertConfig,
  artifactUpsertConfig,
  decisionUpsertConfig,
  blockerUpsertConfig,
  questionUpsertConfig,
  hypothesisUpsertConfig,
  appendEvidenceRefs,
  markSuperseded,
} from '@/lib/server/working-state/normalization'
export type {
  TimedWorkingItem,
  UpsertConfig,
  WorkingStateDeterministicUpdateInput,
  WorkingStateExtractionInput,
  SynchronizeWorkingStateForTurnInput,
} from '@/lib/server/working-state/normalization'

// extraction.ts re-exports
export {
  parseStructuredObject,
  extractFirstJsonObject,
  parseWorkingStatePatchResponse,
  renderStateForExtraction,
  summarizeToolEvents,
  buildWorkingStatePatchPrompt,
  collectJsonCandidates,
  uniqueByKey,
  looksLikeUrl,
  looksLikeFilePath,
  extractPlainTextArtifacts,
  deterministicEvidencePatch,
  extractWorkingStatePatch,
  shouldExtractStructuredPatch,
} from '@/lib/server/working-state/extraction'

// prompt.ts re-exports
export { buildWorkingStatePromptBlockFromState } from '@/lib/server/working-state/prompt'

// ---------------------------------------------------------------------------
// CRUD / coordination layer
// ---------------------------------------------------------------------------

export function loadSessionWorkingState(sessionId: string): SessionWorkingState | null {
  const stored = loadPersistedWorkingState(sessionId)
  if (!stored) return null
  return normalizeWorkingState(stored, sessionId)
}

export function getOrCreateSessionWorkingState(sessionId: string): SessionWorkingState {
  return loadSessionWorkingState(sessionId) || defaultWorkingState(sessionId)
}

export function saveSessionWorkingState(state: SessionWorkingState): SessionWorkingState {
  const normalized = compactWorkingStateObject(normalizeWorkingState(state, state.sessionId))
  upsertPersistedWorkingState(normalized.sessionId, normalized as unknown as Record<string, unknown>)
  return normalized
}

export function deleteSessionWorkingState(sessionId: string): void {
  deletePersistedWorkingState(sessionId)
}

export function applyWorkingStatePatch(
  sessionId: string,
  patch: WorkingStatePatch,
): SessionWorkingState {
  const current = getOrCreateSessionWorkingState(sessionId)
  const next: SessionWorkingState = {
    ...current,
    objective: patch.objective !== undefined ? (cleanMultiline(patch.objective, 900) || null) : current.objective,
    summary: patch.summary !== undefined ? (cleanMultiline(patch.summary, 600) || null) : current.summary,
    constraints: patch.constraints !== undefined ? normalizeList(patch.constraints, 12, 240) : current.constraints,
    successCriteria: patch.successCriteria !== undefined ? normalizeList(patch.successCriteria, 12, 240) : current.successCriteria,
    status: patch.status !== undefined && patch.status !== null ? normalizeStateStatus(patch.status, current.status) : current.status,
    nextAction: patch.nextAction !== undefined ? (cleanText(patch.nextAction, 240) || null) : current.nextAction,
    planSteps: upsertItems(current.planSteps, patch.planSteps, {
      max: MAX_PLAN_STEPS,
      getPatchId: (item) => cleanText(item.id, 120) || null,
      getPatchKey: (item) => cleanText(item.text, 240),
      getItemKey: (item) => item.text,
      create: (item, nowTs) => ({
        id: cleanText(item.id, 120) || genId(12),
        text: cleanText(item.text, 240),
        status: normalizeItemStatus(item.status),
        createdAt: nowTs,
        updatedAt: nowTs,
      }),
      merge: (item, patchItem, nowTs) => ({
        ...item,
        text: cleanText(patchItem.text, 240) || item.text,
        status: normalizeItemStatus(patchItem.status, item.status),
        updatedAt: nowTs,
      }),
      compact: compactPlanSteps,
    }),
    confirmedFacts: upsertItems(current.confirmedFacts, patch.factsUpsert, factUpsertConfig()),
    artifacts: upsertItems(current.artifacts, patch.artifactsUpsert, artifactUpsertConfig()),
    decisions: upsertItems(current.decisions, patch.decisionsAppend, decisionUpsertConfig()),
    blockers: upsertItems(current.blockers, patch.blockersUpsert, blockerUpsertConfig()),
    openQuestions: upsertItems(current.openQuestions, patch.questionsUpsert, questionUpsertConfig()),
    hypotheses: upsertItems(current.hypotheses, patch.hypothesesUpsert, hypothesisUpsertConfig()),
    evidenceRefs: appendEvidenceRefs(current.evidenceRefs, patch.evidenceAppend),
    updatedAt: now(),
  }

  next.planSteps = markSuperseded(next.planSteps, patch.supersedeIds)
  next.confirmedFacts = markSuperseded(next.confirmedFacts, patch.supersedeIds)
  next.artifacts = markSuperseded(next.artifacts, patch.supersedeIds)
  next.decisions = markSuperseded(next.decisions, patch.supersedeIds)
  next.blockers = markSuperseded(next.blockers, patch.supersedeIds)
  next.openQuestions = markSuperseded(next.openQuestions, patch.supersedeIds)
  next.hypotheses = markSuperseded(next.hypotheses, patch.supersedeIds)

  const compacted = compactWorkingStateObject(next)
  upsertPersistedWorkingState(sessionId, compacted as unknown as Record<string, unknown>)
  return compacted
}

export function recordWorkingStateEvidence(input: WorkingStateDeterministicUpdateInput): SessionWorkingState {
  return applyWorkingStatePatch(
    input.sessionId,
    deterministicEvidencePatch(input),
  )
}

export async function synchronizeWorkingStateForTurn(
  input: SynchronizeWorkingStateForTurnInput,
  options?: {
    generateText?: (prompt: string) => Promise<string>
  },
): Promise<SessionWorkingState> {
  const deterministic = recordWorkingStateEvidence(input)
  if (!shouldExtractStructuredPatch(input)) return deterministic
  const patch = await extractWorkingStatePatch({
    ...input,
    currentState: deterministic,
  }, options)
  if (!patch) return deterministic
  return applyWorkingStatePatch(input.sessionId, patch)
}

export function syncWorkingStateFromMainLoopState(input: {
  sessionId: string
  goal?: string | null
  summary?: string | null
  status?: WorkingStateStatus | null
  nextAction?: string | null
  planSteps?: string[]
  completedPlanSteps?: string[]
  blockers?: Array<{ summary: string; kind?: WorkingBlocker['kind'] | null }>
  facts?: string[]
}): SessionWorkingState {
  const planSteps = (() => {
    const activeSteps = Array.isArray(input.planSteps)
      ? input.planSteps
        .map((step) => cleanText(step, 240))
        .filter((step): step is string => Boolean(step))
      : []
    const completedSteps = Array.isArray(input.completedPlanSteps)
      ? input.completedPlanSteps
        .map((step) => cleanText(step, 240))
        .filter((step): step is string => Boolean(step))
      : []
    const out: WorkingPlanStepPatch[] = []
    const seen = new Set<string>()

    for (const [index, step] of activeSteps.entries()) {
      const key = step.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        text: step,
        status: index === 0 && input.status !== 'completed' ? 'active' : 'resolved',
      } satisfies WorkingPlanStepPatch)
    }

    for (const step of completedSteps) {
      const key = step.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        text: step,
        status: 'resolved',
      } satisfies WorkingPlanStepPatch)
    }

    return out.length > 0 ? out : undefined
  })()
  return applyWorkingStatePatch(input.sessionId, {
    objective: cleanMultiline(input.goal, 900) || undefined,
    summary: cleanMultiline(input.summary, 600) || undefined,
    status: input.status || undefined,
    nextAction: cleanText(input.nextAction, 240) || undefined,
    planSteps,
    blockersUpsert: Array.isArray(input.blockers)
      ? input.blockers.map((blocker) => ({
        summary: cleanText(blocker.summary, 280),
        kind: blocker.kind || undefined,
        status: (input.status === 'completed' ? 'resolved' : 'active') as WorkingStateItemStatus,
      })).filter((blocker) => blocker.summary)
      : undefined,
    factsUpsert: Array.isArray(input.facts)
      ? input.facts.map((fact) => ({
        statement: cleanText(fact, 280),
        source: 'system' as const,
        status: (input.status === 'completed' ? 'resolved' : 'active') as WorkingStateItemStatus,
      })).filter((fact) => fact.statement)
      : undefined,
  })
}

export function buildWorkingStatePromptBlock(
  sessionId: string,
): string {
  const state = loadSessionWorkingState(sessionId)
  return buildWorkingStatePromptBlockFromState(state)
}
