/**
 * Protocol step/phase helpers: beginPhase, finishPhase, beginStep, finishStep, etc.
 * Group G11 from protocol-service.ts
 */
import { z } from 'zod'
import { HumanMessage } from '@langchain/core/messages'
import { log } from '@/lib/server/logger'
import { genId } from '@/lib/id'

const TAG = 'protocol-step-helpers'
import type {
  ProtocolBranchCase,
  ProtocolConditionDefinition,
  ProtocolParallelBranchDefinition,
  ProtocolPhaseDefinition,
  ProtocolRun,
  ProtocolRunArtifact,
  ProtocolRunForEachStepState,
  ProtocolRunParallelBranchState,
  ProtocolRunParallelStepState,
  ProtocolRunStatus,
  ProtocolStepDefinition,
} from '@/types'
import { computeStepReadiness } from '@/lib/server/protocols/dag-scheduler'
import { buildLLM } from '@/lib/server/build-llm'
import { errorMessage } from '@/lib/shared-utils'
import { cleanText, isDiscussionStepKind, now, uniqueIds } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import { findRunStep, loadProtocolRunById, normalizeProtocolRun } from '@/lib/server/protocols/protocol-normalization'
import {
  appendProtocolEvent,
  appendTranscriptMessage,
  chooseFacilitator,
  extractFirstJsonObject,
  persistRun,
  updateRun,
} from '@/lib/server/protocols/protocol-agent-turn'
import { isTerminalProtocolRunStatus } from '@/lib/server/protocols/protocol-templates'

// ---- BranchDecisionSchema ----

const BranchDecisionSchema = z.object({
  caseId: z.string().min(1),
})

// ---- Step/Phase helpers (G11) ----

export function phaseFromStep(step: ProtocolStepDefinition): ProtocolPhaseDefinition {
  if (!isDiscussionStepKind(step.kind)) {
    throw new Error(`Structured-session step "${step.id}" is not a discussion phase.`)
  }
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    instructions: step.instructions || null,
    turnLimit: step.turnLimit ?? null,
    completionCriteria: step.completionCriteria || null,
    taskConfig: step.taskConfig || null,
    delegationConfig: step.delegationConfig || null,
    a2aDelegateConfig: step.a2aDelegateConfig || null,
  }
}

export function currentStep(run: ProtocolRun): ProtocolStepDefinition | null {
  const explicit = findRunStep(run, run.currentStepId)
  if (explicit) return explicit
  if (!Array.isArray(run.steps) || run.steps.length === 0) return null
  if (run.currentPhaseIndex >= run.steps.length) return null
  return run.steps[Math.max(0, Math.min(run.currentPhaseIndex, run.steps.length - 1))] || null
}

export function findParallelStepIdForJoin(run: ProtocolRun, joinStep: ProtocolStepDefinition): string | null {
  const explicit = cleanText(joinStep.join?.parallelStepId, 64)
  if (explicit) return explicit
  if (!Array.isArray(run.steps)) return null
  const joinIndex = run.steps.findIndex((step) => step.id === joinStep.id)
  if (joinIndex <= 0) return null
  for (let index = joinIndex - 1; index >= 0; index -= 1) {
    const candidate = run.steps[index]
    if (candidate.kind !== 'parallel') continue
    if (candidate.nextStepId === joinStep.id || run.parallelState?.[candidate.id]) return candidate.id
  }
  return null
}

export function buildParallelBranchRunTitle(run: ProtocolRun, step: ProtocolStepDefinition, branch: ProtocolParallelBranchDefinition): string {
  return [
    cleanText(run.title, 120) || 'Structured Session',
    cleanText(step.label, 80) || 'Parallel Step',
    cleanText(branch.label, 80) || 'Branch',
  ].filter(Boolean).join(' · ')
}

export function buildParallelBranchGoal(run: ProtocolRun, step: ProtocolStepDefinition, branch: ProtocolParallelBranchDefinition): string | null {
  const baseGoal = cleanText(run.config?.goal, 600) || cleanText(run.title, 220)
  const focus = [
    cleanText(step.label, 120),
    cleanText(branch.label, 120),
  ].filter(Boolean).join(' / ')
  if (!baseGoal && !focus) return null
  if (!baseGoal) return `Branch focus: ${focus}`
  if (!focus) return baseGoal
  return `${baseGoal}\nBranch focus: ${focus}`
}

export function summarizeProtocolRunBranch(run: ProtocolRun | null): string | null {
  if (!run) return null
  const explicitSummary = cleanText(run.summary, 4_000)
  if (explicitSummary) return explicitSummary
  const latestArtifact = Array.isArray(run.artifacts) ? run.artifacts[run.artifacts.length - 1] : null
  const artifactContent = cleanText(latestArtifact?.content, 4_000)
  if (artifactContent) return artifactContent
  return cleanText(run.lastError, 320) || null
}

export function buildParallelBranchState(run: ProtocolRun | null, fallback: Partial<ProtocolRunParallelBranchState> & { branchId: string; label: string; runId: string }): ProtocolRunParallelBranchState {
  return {
    branchId: cleanText(fallback.branchId, 64),
    label: cleanText(fallback.label, 120) || 'Branch',
    runId: cleanText(fallback.runId, 64),
    status: run?.status || fallback.status || 'draft',
    participantAgentIds: uniqueIds(run?.participantAgentIds || fallback.participantAgentIds, 64),
    summary: summarizeProtocolRunBranch(run) || cleanText(fallback.summary, 4_000) || null,
    lastError: cleanText(run?.lastError, 320) || cleanText(fallback.lastError, 320) || null,
    updatedAt: typeof run?.updatedAt === 'number' ? run.updatedAt : (typeof fallback.updatedAt === 'number' ? fallback.updatedAt : Date.now()),
  }
}

export function buildParallelStepState(
  stepId: string,
  branches: ProtocolRunParallelBranchState[],
  joinCompletedAt?: number | null,
): ProtocolRunParallelStepState {
  const waitingOnBranchIds = branches
    .filter((branch) => !isTerminalProtocolRunStatus(branch.status))
    .map((branch) => branch.branchId)
  return {
    stepId,
    branchRunIds: branches.map((branch) => branch.runId),
    branches,
    waitingOnBranchIds,
    joinReady: waitingOnBranchIds.length === 0 && branches.length > 0,
    joinCompletedAt: typeof joinCompletedAt === 'number' ? joinCompletedAt : null,
  }
}

export function syncProtocolParentFromChildRun(runOrId: ProtocolRun | string, deps?: ProtocolRunDeps): ProtocolRun | null {
  const subflowMod = require('@/lib/server/protocols/protocol-subflow') as typeof import('@/lib/server/protocols/protocol-subflow')
  const lifecycleMod = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')

  const child = typeof runOrId === 'string' ? loadProtocolRunById(runOrId) : normalizeProtocolRun(runOrId)
  if (!child?.parentRunId || !child.parentStepId) return null
  const parent = loadProtocolRunById(child.parentRunId)
  if (!parent) return null

  // Delegate to for_each sync if parent step has forEachState
  const forEachState = parent.forEachState?.[child.parentStepId]
  if (forEachState) {
    return syncForEachParentFromChildRun(child, parent, forEachState, deps)
  }

  // Delegate to subflow sync if parent step has subflowState
  const subflowState = parent.subflowState?.[child.parentStepId]
  if (subflowState && subflowState.childRunId === child.id) {
    if (typeof subflowMod.syncSubflowParentFromChildRun !== 'function') {
      log.warn(TAG, 'syncSubflowParentFromChildRun not available (circular dep not yet resolved), skipping subflow sync')
      return parent
    }
    return subflowMod.syncSubflowParentFromChildRun(child, parent, subflowState, deps)
  }

  const existingState = parent.parallelState?.[child.parentStepId]
  if (!existingState) return parent
  const nextBranches = existingState.branches.map((branch) => (
    branch.runId === child.id ? buildParallelBranchState(child, branch) : branch
  ))
  const nextState = buildParallelStepState(child.parentStepId, nextBranches, existingState.joinCompletedAt || null)
  const previousBranch = existingState.branches.find((branch) => branch.runId === child.id) || null
  const previousStatus = previousBranch?.status || null
  const updatedParent = updateRun(parent.id, (current) => ({
    ...current,
    parallelState: {
      ...(current.parallelState || {}),
      [child.parentStepId!]: nextState,
    },
    updatedAt: now(deps),
  }))
  if (!updatedParent) return null
  if (previousStatus !== child.status && isTerminalProtocolRunStatus(child.status)) {
    appendProtocolEvent(updatedParent.id, {
      type: child.status === 'completed' ? 'parallel_branch_completed' : 'parallel_branch_failed',
      stepId: child.parentStepId,
      summary: child.status === 'completed'
        ? `Parallel branch "${previousBranch?.label || child.branchId || child.id}" completed.`
        : `Parallel branch "${previousBranch?.label || child.branchId || child.id}" ended with ${child.status}.`,
      data: { branchId: child.branchId, childRunId: child.id, status: child.status },
    }, deps)
  }
  if (nextState.joinReady && existingState.joinReady !== true) {
    appendProtocolEvent(updatedParent.id, {
      type: 'join_ready',
      stepId: child.parentStepId,
      summary: 'All parallel branches reached a terminal state and the join can continue.',
      data: { childRunIds: nextState.branchRunIds },
    }, deps)
  }
  if (nextState.joinReady && updatedParent.status === 'waiting') {
    if (typeof lifecycleMod.requestProtocolRunExecution === 'function') {
      lifecycleMod.requestProtocolRunExecution(updatedParent.id, deps)
    }
  }
  return loadProtocolRunById(updatedParent.id)
}

function maybeAppendLoopIterationCompleted(
  run: ProtocolRun,
  completedStep: ProtocolStepDefinition | null,
  nextStepId: string | null,
  deps?: ProtocolRunDeps,
): void {
  if (!completedStep || !nextStepId) return
  const repeatStep = findRunStep(run, nextStepId)
  if (!repeatStep || repeatStep.kind !== 'repeat' || repeatStep.repeat?.bodyStepId !== completedStep.id) return
  const iterationCount = run.loopState?.[repeatStep.id]?.iterationCount || 0
  appendProtocolEvent(run.id, {
    type: 'loop_iteration_completed',
    stepId: repeatStep.id,
    summary: `Completed loop iteration ${iterationCount} for ${repeatStep.label}.`,
    data: {
      bodyStepId: completedStep.id,
      iterationCount,
    },
  }, deps)
}

export function beginPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  if (run.phaseState?.phaseId === phase.id && run.currentStepId === phase.id) return run
  appendProtocolEvent(run.id, {
    type: 'phase_started',
    phaseId: phase.id,
    stepId: phase.id,
    summary: `Started phase: ${phase.label}`,
    data: { kind: phase.kind },
  }, deps)
  // Update DAG stepState to 'running' if applicable
  const dagUpdate: Partial<ProtocolRun> = {}
  if (run.stepState && Object.keys(run.stepState).length > 0) {
    const step = findRunStep(run, phase.id)
    if (step) {
      dagUpdate.stepState = {
        ...run.stepState,
        [step.id]: {
          stepId: step.id,
          status: 'running',
          startedAt: now(deps),
          completedAt: null,
          error: null,
        },
      }
      dagUpdate.runningStepIds = [...(run.runningStepIds || []).filter((id) => id !== step.id), step.id]
      dagUpdate.readyStepIds = (run.readyStepIds || []).filter((id) => id !== step.id)
    }
  }
  return persistRun({
    ...run,
    ...dagUpdate,
    status: run.status === 'draft' ? 'running' : run.status,
    currentStepId: phase.id,
    phaseState: {
      phaseId: phase.id,
      respondedAgentIds: [],
      responses: [],
      appendedToTranscript: false,
      artifactId: null,
    },
    updatedAt: now(deps),
  })
}

export function finishPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const step = findRunStep(run, phase.id)
  const nextStepId = cleanText(step?.nextStepId, 64) || null
  appendProtocolEvent(run.id, {
    type: 'phase_completed',
    phaseId: phase.id,
    stepId: phase.id,
    summary: `Completed phase: ${phase.label}`,
  }, deps)
  maybeAppendLoopIterationCompleted(run, step, nextStepId, deps)

  // In DAG mode, delegate to finishStep which updates stepState and recomputes readiness
  const isDagMode = run.stepState && Object.keys(run.stepState).length > 0
  if (isDagMode && step) {
    return finishStep(
      persistRun({ ...run, phaseState: null, updatedAt: now(deps) }),
      step,
      nextStepId,
      deps,
    )
  }

  // Non-DAG mode: original cursor-based advancement
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  return persistRun({
    ...run,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    phaseState: null,
    updatedAt: now(deps),
  })
}

export function completeProtocolRun(run: ProtocolRun, deps?: ProtocolRunDeps, summary = 'Structured session completed.'): ProtocolRun {
  const completed = persistRun({
    ...run,
    status: 'completed',
    currentStepId: null,
    currentPhaseIndex: Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex,
    endedAt: run.endedAt || now(deps),
    updatedAt: now(deps),
    waitingReason: null,
    phaseState: null,
  })
  appendProtocolEvent(run.id, {
    type: 'completed',
    summary,
  }, deps)
  emitSummaryToParentChatroom(completed, deps)
  return completed
}

export function evaluateProtocolCondition(run: ProtocolRun, condition: ProtocolConditionDefinition | null | undefined): boolean {
  if (!condition) return false
  if (condition.type === 'summary_exists') {
    return Boolean(cleanText(run.summary, 4_000))
  }
  if (condition.type === 'artifact_exists') {
    return (run.artifacts || []).some((artifact) => !condition.artifactKind || artifact.kind === condition.artifactKind)
  }
  if (condition.type === 'artifact_count_at_least') {
    const count = (run.artifacts || []).filter((artifact) => !condition.artifactKind || artifact.kind === condition.artifactKind).length
    return count >= Math.max(0, Math.trunc(condition.count || 0))
  }
  if (condition.type === 'created_task_count_at_least') {
    return (run.createdTaskIds || []).length >= Math.max(0, Math.trunc(condition.count || 0))
  }
  if (condition.type === 'all') {
    return Array.isArray(condition.conditions) && condition.conditions.length > 0 && condition.conditions.every((entry) => evaluateProtocolCondition(run, entry))
  }
  if (condition.type === 'any') {
    return Array.isArray(condition.conditions) && condition.conditions.some((entry) => evaluateProtocolCondition(run, entry))
  }
  return false
}

export async function defaultDecideBranchCase(
  run: ProtocolRun,
  step: ProtocolStepDefinition,
  cases: ProtocolBranchCase[],
): Promise<{ caseId: string; nextStepId: string } | null> {
  const facilitatorId = chooseFacilitator(run)
  if (!facilitatorId || cases.length === 0) return null
  try {
    const { llm } = await buildLLM({
      sessionId: run.sessionId || null,
      agentId: facilitatorId,
    })
    const prompt = [
      'Choose the next branch for this structured session.',
      'Return JSON only.',
      '',
      'Output shape:',
      '{"caseId":"required"}',
      '',
      `run_title: ${JSON.stringify(cleanText(run.title, 200) || '(none)')}`,
      `step_label: ${JSON.stringify(step.label)}`,
      `goal: ${JSON.stringify(cleanText(run.config?.goal, 600) || '(none)')}`,
      `summary: ${JSON.stringify(cleanText(run.summary, 6_000) || '(none)')}`,
      `artifacts: ${JSON.stringify((run.artifacts || []).map((artifact) => ({ kind: artifact.kind, title: artifact.title })).slice(-12))}`,
      `created_tasks: ${JSON.stringify((run.createdTaskIds || []).slice(-16))}`,
      `operator_context: ${JSON.stringify((run.operatorContext || []).slice(-8))}`,
      `cases: ${JSON.stringify(cases.map((branchCase) => ({
        id: branchCase.id,
        label: branchCase.label,
        description: branchCase.description || null,
      })))}`,
    ].join('\n')
    const response = await llm.invoke([new HumanMessage(prompt)])
    const jsonText = extractFirstJsonObject(String(response.content || ''))
    if (!jsonText) return null
    const parsed = BranchDecisionSchema.safeParse(JSON.parse(jsonText))
    if (!parsed.success) return null
    const selected = cases.find((branchCase) => branchCase.id === parsed.data.caseId)
    return selected ? { caseId: selected.id, nextStepId: selected.nextStepId } : null
  } catch (err: unknown) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `Branch decision failed: ${cleanText(errorMessage(err), 200) || 'unknown error'}`,
    })
    return null
  }
}

export function beginStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  appendProtocolEvent(run.id, {
    type: 'step_started',
    stepId: step.id,
    summary: `Started step: ${step.label}`,
    data: { kind: step.kind },
  }, deps)
  const dagUpdate: Partial<ProtocolRun> = {}
  if (run.stepState && Object.keys(run.stepState).length > 0) {
    dagUpdate.stepState = {
      ...run.stepState,
      [step.id]: {
        stepId: step.id,
        status: 'running',
        startedAt: now(deps),
        completedAt: null,
        error: null,
      },
    }
    dagUpdate.runningStepIds = [...(run.runningStepIds || []).filter((id) => id !== step.id), step.id]
    dagUpdate.readyStepIds = (run.readyStepIds || []).filter((id) => id !== step.id)
  }
  return persistRun({
    ...run,
    ...dagUpdate,
    status: run.status === 'draft' ? 'running' : run.status,
    currentStepId: step.id,
    updatedAt: now(deps),
  })
}

export function finishStep(run: ProtocolRun, step: ProtocolStepDefinition, nextStepId: string | null, deps?: ProtocolRunDeps): ProtocolRun {
  appendProtocolEvent(run.id, {
    type: 'step_completed',
    stepId: step.id,
    summary: `Completed step: ${step.label}`,
  }, deps)
  maybeAppendLoopIterationCompleted(run, step, nextStepId, deps)

  const isDagMode = run.stepState && Object.keys(run.stepState).length > 0
  if (isDagMode) {
    // In DAG mode, mark step completed and let scheduler recompute readiness
    const stepState = {
      ...run.stepState,
      [step.id]: {
        stepId: step.id,
        status: 'completed' as const,
        startedAt: run.stepState?.[step.id]?.startedAt || null,
        completedAt: now(deps),
        error: null,
      },
    }
    // Recompute readiness after marking this step done
    const sched = computeStepReadiness(run.steps || [], run.entryStepId || null, stepState)
    const nextReady = sched.readyStepIds[0] || nextStepId || null
    const nextIndex = nextReady && Array.isArray(run.steps)
      ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextReady))
      : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
    return persistRun({
      ...run,
      currentStepId: nextReady,
      currentPhaseIndex: nextIndex,
      waitingReason: null,
      pauseReason: null,
      phaseState: null,
      stepState: sched.stepState,
      completedStepIds: sched.completedStepIds,
      runningStepIds: sched.runningStepIds,
      readyStepIds: sched.readyStepIds,
      failedStepIds: sched.failedStepIds,
      updatedAt: now(deps),
    })
  }

  // Non-DAG mode: original cursor-based advancement
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  return persistRun({
    ...run,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    waitingReason: null,
    pauseReason: null,
    phaseState: null,
    updatedAt: now(deps),
  })
}

export function currentArtifact(run: ProtocolRun): ProtocolRunArtifact | null {
  if (!Array.isArray(run.artifacts) || run.artifacts.length === 0) return null
  if (run.latestArtifactId) {
    const exact = run.artifacts.find((artifact) => artifact.id === run.latestArtifactId)
    if (exact) return exact
  }
  return run.artifacts[run.artifacts.length - 1] || null
}

export function appendArtifact(
  run: ProtocolRun,
  artifact: ProtocolRunArtifact,
  deps?: ProtocolRunDeps,
  options?: { citations?: import('@/types').KnowledgeCitation[] },
): ProtocolRun {
  const next = persistRun({
    ...run,
    artifacts: [...(run.artifacts || []), artifact],
    latestArtifactId: artifact.id,
    ...(artifact.kind === 'summary' ? { summary: artifact.content } : {}),
    phaseState: run.phaseState
      ? { ...run.phaseState, artifactId: artifact.id }
      : run.phaseState,
    updatedAt: now(deps),
  })
  appendProtocolEvent(run.id, {
    type: 'artifact_emitted',
    phaseId: artifact.phaseId || null,
    artifactId: artifact.id,
    summary: `Emitted ${artifact.kind.replace(/_/g, ' ')}: ${artifact.title}`,
    citations: options?.citations,
  }, deps)
  return next
}

export function emitSummaryToParentChatroom(run: ProtocolRun, deps?: ProtocolRunDeps): void {
  if (!run.parentChatroomId || !run.summary || run.config?.postSummaryToParent === false) return
  const message = [
    `[Structured session complete] ${run.title}`,
    '',
    cleanText(run.summary, 3_000),
  ].join('\n')
  const appended = appendTranscriptMessage(run.parentChatroomId, {
    senderId: 'system',
    senderName: 'System',
    role: 'assistant',
    text: message,
    mentions: [],
    reactions: [],
  }, deps)
  if (appended) {
    appendProtocolEvent(run.id, {
      type: 'summary_posted',
      summary: 'Posted the final structured-session summary back to the parent chatroom.',
      data: { parentChatroomId: run.parentChatroomId },
    }, deps)
  }
}

/**
 * Sync a for-each parent run from a completed child branch run.
 * Moved here from protocol-foreach.ts to break the circular dependency:
 *   protocol-step-helpers → protocol-foreach → protocol-step-helpers
 */
export function syncForEachParentFromChildRun(
  child: ProtocolRun,
  parent: ProtocolRun,
  forEachState: ProtocolRunForEachStepState,
  deps?: ProtocolRunDeps,
): ProtocolRun | null {
  const nextBranches = forEachState.branches.map((branch) => (
    branch.runId === child.id ? buildParallelBranchState(child, branch) : branch
  ))
  const waitingOnBranchIds = nextBranches
    .filter((b) => !isTerminalProtocolRunStatus(b.status))
    .map((b) => b.branchId)
  const joinReady = waitingOnBranchIds.length === 0 && nextBranches.length > 0
  const nextState: ProtocolRunForEachStepState = {
    ...forEachState,
    branches: nextBranches,
    waitingOnBranchIds,
    joinReady,
    joinCompletedAt: joinReady && !forEachState.joinCompletedAt ? now(deps) : forEachState.joinCompletedAt || null,
  }

  const updatedParent = updateRun(parent.id, (current) => ({
    ...current,
    forEachState: {
      ...(current.forEachState || {}),
      [child.parentStepId!]: nextState,
    },
    updatedAt: now(deps),
  }))
  if (!updatedParent) return null

  if (isTerminalProtocolRunStatus(child.status)) {
    appendProtocolEvent(updatedParent.id, {
      type: child.status === 'completed' ? 'parallel_branch_completed' : 'parallel_branch_failed',
      stepId: child.parentStepId,
      summary: `For-each branch "${child.branchId || child.id}" ${child.status}.`,
      data: { branchId: child.branchId, childRunId: child.id, status: child.status },
    }, deps)
  }

  if (joinReady && !forEachState.joinReady) {
    appendProtocolEvent(updatedParent.id, {
      type: 'join_ready',
      stepId: child.parentStepId,
      summary: 'All for-each branches completed. Advancing parent.',
      data: { childRunIds: nextState.branchRunIds },
    }, deps)
  }

  if (joinReady && updatedParent.status === 'waiting') {
    // Advance past the for_each step
    const parentStep = findRunStep(updatedParent, child.parentStepId!)
    if (parentStep) {
      const nextStepId = parentStep.nextStepId || null
      const nextIndex = nextStepId && Array.isArray(updatedParent.steps)
        ? Math.max(0, updatedParent.steps.findIndex((s) => s.id === nextStepId))
        : Array.isArray(updatedParent.steps) ? updatedParent.steps.length : updatedParent.currentPhaseIndex + 1
      persistRun({
        ...updatedParent,
        status: 'running',
        currentStepId: nextStepId,
        currentPhaseIndex: nextIndex,
        waitingReason: null,
        updatedAt: now(deps),
      })
    }
    const { requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')
    requestProtocolRunExecution(updatedParent.id, deps)
  }
  return loadProtocolRunById(updatedParent.id)
}
