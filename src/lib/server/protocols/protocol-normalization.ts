/**
 * Protocol normalization functions.
 * Group G3 from protocol-service.ts
 */
import { genId } from '@/lib/id'
import type {
  ProtocolBranchCase,
  ProtocolConditionDefinition,
  ProtocolForEachConfig,
  ProtocolJoinConfig,
  ProtocolParallelBranchDefinition,
  ProtocolParallelConfig,
  ProtocolPhaseDefinition,
  ProtocolRepeatConfig,
  ProtocolRun,
  ProtocolRunArtifact,
  ProtocolRunBranchDecision,
  ProtocolRunForEachStepState,
  ProtocolRunLoopState,
  ProtocolRunParallelBranchState,
  ProtocolRunParallelStepState,
  ProtocolRunStatus,
  ProtocolRunStepState,
  ProtocolRunSubflowState,
  ProtocolRunSwarmState,
  ProtocolSourceRef,
  ProtocolStepDefinition,
  ProtocolSubflowConfig,
  ProtocolSwarmConfig,
  ProtocolTemplate,
} from '@/types'
import { loadProtocolRun } from '@/lib/server/protocols/protocol-run-repository'
import { normalizeStepOutputs } from '@/lib/server/protocols/step-outputs'
import { cleanText, uniqueIds } from '@/lib/server/protocols/protocol-types'

export function normalizeCondition(condition: ProtocolConditionDefinition | null | undefined): ProtocolConditionDefinition | null {
  if (!condition || typeof condition !== 'object') return null
  if (condition.type === 'summary_exists') return { type: 'summary_exists' }
  if (condition.type === 'artifact_exists') {
    return {
      type: 'artifact_exists',
      artifactKind: typeof condition.artifactKind === 'string' ? condition.artifactKind : null,
    }
  }
  if (condition.type === 'artifact_count_at_least') {
    return {
      type: 'artifact_count_at_least',
      count: Math.max(0, Math.trunc(condition.count || 0)),
      artifactKind: typeof condition.artifactKind === 'string' ? condition.artifactKind : null,
    }
  }
  if (condition.type === 'created_task_count_at_least') {
    return {
      type: 'created_task_count_at_least',
      count: Math.max(0, Math.trunc(condition.count || 0)),
    }
  }
  if (condition.type === 'all' || condition.type === 'any') {
    return {
      type: condition.type,
      conditions: Array.isArray(condition.conditions)
        ? condition.conditions.map((entry) => normalizeCondition(entry)).filter(Boolean) as ProtocolConditionDefinition[]
        : [],
    }
  }
  return null
}

export function normalizeBranchCase(branchCase: ProtocolBranchCase): ProtocolBranchCase {
  return {
    id: cleanText(branchCase.id, 64) || genId(),
    label: cleanText(branchCase.label, 120) || 'Case',
    nextStepId: cleanText(branchCase.nextStepId, 64),
    description: cleanText(branchCase.description, 600) || null,
    when: normalizeCondition(branchCase.when),
  }
}

export function normalizeRepeatConfig(repeat: ProtocolRepeatConfig | null | undefined): ProtocolRepeatConfig | null {
  if (!repeat || typeof repeat !== 'object') return null
  return {
    bodyStepId: cleanText(repeat.bodyStepId, 64),
    nextStepId: cleanText(repeat.nextStepId, 64) || null,
    maxIterations: Math.max(1, Math.trunc(repeat.maxIterations || 1)),
    exitCondition: normalizeCondition(repeat.exitCondition),
    onExhausted: repeat.onExhausted === 'advance' ? 'advance' : 'fail',
  }
}

export function normalizeParallelBranch(branch: ProtocolParallelBranchDefinition): ProtocolParallelBranchDefinition {
  const steps = Array.isArray(branch.steps) ? branch.steps.map(normalizeStep) : []
  const entryStepId = cleanText(branch.entryStepId, 64) || steps[0]?.id || null
  return {
    id: cleanText(branch.id, 64) || genId(),
    label: cleanText(branch.label, 120) || 'Branch',
    steps,
    entryStepId,
    participantAgentIds: uniqueIds(branch.participantAgentIds, 64),
    facilitatorAgentId: cleanText(branch.facilitatorAgentId, 64) || null,
    observerAgentIds: uniqueIds(branch.observerAgentIds, 32),
  }
}

export function normalizeParallelConfig(parallel: ProtocolParallelConfig | null | undefined): ProtocolParallelConfig | null {
  if (!parallel || typeof parallel !== 'object') return null
  const branches = Array.isArray(parallel.branches) ? parallel.branches.map(normalizeParallelBranch) : []
  if (branches.length === 0) return null
  return { branches }
}

export function normalizeJoinConfig(join: ProtocolJoinConfig | null | undefined): ProtocolJoinConfig | null {
  if (!join || typeof join !== 'object') return null
  return {
    parallelStepId: cleanText(join.parallelStepId, 64) || null,
  }
}

export function phaseToStepDefinition(phase: ProtocolPhaseDefinition, nextStepId: string | null): ProtocolStepDefinition {
  return {
    id: cleanText(phase.id, 64) || genId(),
    kind: phase.kind,
    label: cleanText(phase.label, 120) || phase.kind,
    instructions: cleanText(phase.instructions, 600) || null,
    turnLimit: typeof phase.turnLimit === 'number' ? phase.turnLimit : null,
    completionCriteria: cleanText(phase.completionCriteria, 240) || null,
    nextStepId,
    branchCases: [],
    defaultNextStepId: null,
    repeat: null,
    parallel: null,
    join: null,
  }
}

export function compilePhasesToSteps(phases: ProtocolPhaseDefinition[]): { steps: ProtocolStepDefinition[]; entryStepId: string | null } {
  const normalized = Array.isArray(phases) ? phases.map((phase) => ({
    id: cleanText(phase.id, 64) || genId(),
    kind: phase.kind,
    label: cleanText(phase.label, 120) || phase.kind,
    instructions: cleanText(phase.instructions, 600) || null,
    turnLimit: typeof phase.turnLimit === 'number' ? phase.turnLimit : null,
    completionCriteria: cleanText(phase.completionCriteria, 240) || null,
  })) : []
  const steps = normalized.map((phase, index) => phaseToStepDefinition(phase, normalized[index + 1]?.id || null))
  return { steps, entryStepId: steps[0]?.id || null }
}

export function deriveDisplayPhasesFromSteps(steps: ProtocolStepDefinition[]): ProtocolPhaseDefinition[] {
  return steps
    .filter((step) => isDiscussionStepKindLocal(step.kind))
    .map((step) => ({
      id: step.id,
      kind: step.kind as ProtocolPhaseDefinition['kind'],
      label: step.label,
      instructions: step.instructions || null,
      turnLimit: step.turnLimit ?? null,
      completionCriteria: step.completionCriteria || null,
    }))
}

// Local copy to avoid circular import — isDiscussionStepKind is re-exported from protocol-types
function isDiscussionStepKindLocal(kind: string): boolean {
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
    'a2a_delegate',
  ].includes(kind)
}

export function normalizeForEachConfig(config: ProtocolForEachConfig | null | undefined): ProtocolForEachConfig | null {
  if (!config || typeof config !== 'object') return null
  if (!config.itemsSource || !config.itemAlias || !config.branchTemplate?.steps?.length) return null
  return {
    itemsSource: config.itemsSource,
    itemAlias: config.itemAlias,
    branchTemplate: {
      steps: config.branchTemplate.steps.map(normalizeStep),
      entryStepId: cleanText(config.branchTemplate.entryStepId, 64) || config.branchTemplate.steps[0]?.id || null,
      participantAgentIds: Array.isArray(config.branchTemplate.participantAgentIds) ? config.branchTemplate.participantAgentIds : [],
      facilitatorAgentId: typeof config.branchTemplate.facilitatorAgentId === 'string' ? config.branchTemplate.facilitatorAgentId : null,
    },
    joinMode: 'all',
    maxItems: typeof config.maxItems === 'number' ? Math.min(200, Math.max(1, config.maxItems)) : 50,
    onEmpty: config.onEmpty === 'skip' || config.onEmpty === 'advance' ? config.onEmpty : 'fail',
  }
}

export function normalizeSubflowConfig(config: ProtocolSubflowConfig | null | undefined): ProtocolSubflowConfig | null {
  if (!config || typeof config !== 'object') return null
  if (!config.templateId) return null
  return {
    templateId: config.templateId,
    templateVersion: typeof config.templateVersion === 'string' ? config.templateVersion : null,
    participantAgentIds: Array.isArray(config.participantAgentIds) ? config.participantAgentIds : [],
    facilitatorAgentId: typeof config.facilitatorAgentId === 'string' ? config.facilitatorAgentId : null,
    inputMapping: config.inputMapping && typeof config.inputMapping === 'object' ? config.inputMapping : null,
    outputMapping: config.outputMapping && typeof config.outputMapping === 'object' ? config.outputMapping : null,
    onFailure: config.onFailure === 'advance_with_warning' ? 'advance_with_warning' : 'fail_parent',
  }
}

export function normalizeSwarmConfig(config: ProtocolSwarmConfig | null | undefined): ProtocolSwarmConfig | null {
  if (!config || typeof config !== 'object') return null
  if (!Array.isArray(config.eligibleAgentIds) || config.eligibleAgentIds.length === 0) return null
  if (!config.workItemsSource) return null
  return {
    eligibleAgentIds: config.eligibleAgentIds,
    workItemsSource: config.workItemsSource,
    claimLimitPerAgent: typeof config.claimLimitPerAgent === 'number' ? Math.min(10, Math.max(1, config.claimLimitPerAgent)) : 1,
    selectionMode: config.selectionMode === 'claim_until_empty' ? 'claim_until_empty' : 'first_claim',
    claimTimeoutSec: typeof config.claimTimeoutSec === 'number' ? Math.min(3600, Math.max(30, config.claimTimeoutSec)) : 300,
    onUnclaimed: config.onUnclaimed === 'advance' ? 'advance' : config.onUnclaimed === 'fallback_assign' ? 'fallback_assign' : 'fail',
  }
}

export function normalizeStep(step: ProtocolStepDefinition): ProtocolStepDefinition {
  return {
    id: cleanText(step.id, 64) || genId(),
    kind: step.kind,
    label: cleanText(step.label, 120) || step.kind,
    instructions: cleanText(step.instructions, 600) || null,
    turnLimit: typeof step.turnLimit === 'number' ? step.turnLimit : null,
    completionCriteria: cleanText(step.completionCriteria, 240) || null,
    nextStepId: cleanText(step.nextStepId, 64) || null,
    branchCases: Array.isArray(step.branchCases) ? step.branchCases.map(normalizeBranchCase) : [],
    defaultNextStepId: cleanText(step.defaultNextStepId, 64) || null,
    repeat: normalizeRepeatConfig(step.repeat),
    parallel: normalizeParallelConfig(step.parallel),
    join: normalizeJoinConfig(step.join),
    dependsOnStepIds: Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds.filter((id) => typeof id === 'string' && id.length > 0) : [],
    outputKey: cleanText(step.outputKey, 64) || null,
    forEach: normalizeForEachConfig(step.forEach),
    subflow: normalizeSubflowConfig(step.subflow),
    swarm: normalizeSwarmConfig(step.swarm),
  }
}

export function resolveTemplateSteps(template: Partial<ProtocolTemplate>): { steps: ProtocolStepDefinition[]; entryStepId: string | null } {
  const explicitSteps = Array.isArray(template.steps) ? template.steps.map(normalizeStep) : []
  if (explicitSteps.length > 0) {
    const entryStepId = cleanText(template.entryStepId, 64) || explicitSteps[0]?.id || null
    return { steps: explicitSteps, entryStepId }
  }
  return compilePhasesToSteps(Array.isArray(template.defaultPhases) ? template.defaultPhases : [])
}

export function resolveRunSteps(run: Partial<ProtocolRun>): { steps: ProtocolStepDefinition[]; entryStepId: string | null } {
  const explicitSteps = Array.isArray(run.steps) ? run.steps.map(normalizeStep) : []
  if (explicitSteps.length > 0) {
    const entryStepId = cleanText(run.entryStepId, 64) || explicitSteps[0]?.id || null
    return { steps: explicitSteps, entryStepId }
  }
  return compilePhasesToSteps(Array.isArray(run.phases) ? run.phases : [])
}

function normalizeLoopState(loopState: ProtocolRun['loopState']): Record<string, ProtocolRunLoopState> {
  const out: Record<string, ProtocolRunLoopState> = {}
  if (!loopState || typeof loopState !== 'object') return out
  for (const [stepId, state] of Object.entries(loopState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      iterationCount: Math.max(0, Math.trunc(state.iterationCount || 0)),
    }
  }
  return out
}

function normalizeBranchHistory(history: ProtocolRun['branchHistory']): ProtocolRunBranchDecision[] {
  if (!Array.isArray(history)) return []
  return history
    .map((entry) => ({
      stepId: cleanText(entry.stepId, 64),
      caseId: cleanText(entry.caseId, 64) || null,
      nextStepId: cleanText(entry.nextStepId, 64) || null,
      decidedAt: typeof entry.decidedAt === 'number' ? entry.decidedAt : Date.now(),
    }))
    .filter((entry) => entry.stepId)
}

function normalizeParallelState(parallelState: ProtocolRun['parallelState']): Record<string, ProtocolRunParallelStepState> {
  const out: Record<string, ProtocolRunParallelStepState> = {}
  if (!parallelState || typeof parallelState !== 'object') return out
  for (const [stepId, state] of Object.entries(parallelState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    const branches = Array.isArray(state.branches)
      ? state.branches.map((branch): ProtocolRunParallelBranchState => ({
        branchId: cleanText(branch.branchId, 64),
        label: cleanText(branch.label, 120) || 'Branch',
        runId: cleanText(branch.runId, 64),
        status: branch.status,
        participantAgentIds: uniqueIds(branch.participantAgentIds, 64),
        summary: cleanText(branch.summary, 4_000) || null,
        lastError: cleanText(branch.lastError, 320) || null,
        updatedAt: typeof branch.updatedAt === 'number' ? branch.updatedAt : Date.now(),
      })).filter((branch) => branch.branchId && branch.runId)
      : []
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      branchRunIds: uniqueIds(state.branchRunIds, 64),
      branches,
      waitingOnBranchIds: uniqueIds(state.waitingOnBranchIds, 64),
      joinReady: state.joinReady === true,
      joinCompletedAt: typeof state.joinCompletedAt === 'number' ? state.joinCompletedAt : null,
    }
  }
  return out
}

function normalizeStepState(stepState: ProtocolRun['stepState']): Record<string, ProtocolRunStepState> {
  const out: Record<string, ProtocolRunStepState> = {}
  if (!stepState || typeof stepState !== 'object') return out
  for (const [stepId, state] of Object.entries(stepState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      status: state.status || 'pending',
      startedAt: typeof state.startedAt === 'number' ? state.startedAt : null,
      completedAt: typeof state.completedAt === 'number' ? state.completedAt : null,
      error: typeof state.error === 'string' ? state.error : null,
    }
  }
  return out
}

function normalizeForEachState(forEachState: ProtocolRun['forEachState']): Record<string, ProtocolRunForEachStepState> {
  const out: Record<string, ProtocolRunForEachStepState> = {}
  if (!forEachState || typeof forEachState !== 'object') return out
  for (const [stepId, state] of Object.entries(forEachState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      items: Array.isArray(state.items) ? state.items : [],
      branchRunIds: Array.isArray(state.branchRunIds) ? state.branchRunIds : [],
      branches: Array.isArray(state.branches) ? state.branches.map((b): ProtocolRunParallelBranchState => ({
        branchId: cleanText(b.branchId, 64),
        label: cleanText(b.label, 120) || 'Branch',
        runId: cleanText(b.runId, 64),
        status: b.status,
        participantAgentIds: uniqueIds(b.participantAgentIds, 64),
        summary: cleanText(b.summary, 4_000) || null,
        lastError: cleanText(b.lastError, 320) || null,
        updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : Date.now(),
      })).filter((b) => b.branchId && b.runId) : [],
      waitingOnBranchIds: Array.isArray(state.waitingOnBranchIds) ? state.waitingOnBranchIds : [],
      joinReady: state.joinReady === true,
      joinCompletedAt: typeof state.joinCompletedAt === 'number' ? state.joinCompletedAt : null,
    }
  }
  return out
}

function normalizeSubflowState(subflowState: ProtocolRun['subflowState']): Record<string, ProtocolRunSubflowState> {
  const out: Record<string, ProtocolRunSubflowState> = {}
  if (!subflowState || typeof subflowState !== 'object') return out
  for (const [stepId, state] of Object.entries(subflowState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      childRunId: state.childRunId || '',
      templateId: state.templateId || '',
      status: state.status || 'draft',
      summary: typeof state.summary === 'string' ? state.summary : null,
      lastError: typeof state.lastError === 'string' ? state.lastError : null,
      startedAt: typeof state.startedAt === 'number' ? state.startedAt : null,
      completedAt: typeof state.completedAt === 'number' ? state.completedAt : null,
    }
  }
  return out
}

function normalizeSwarmState(swarmState: ProtocolRun['swarmState']): Record<string, ProtocolRunSwarmState> {
  const out: Record<string, ProtocolRunSwarmState> = {}
  if (!swarmState || typeof swarmState !== 'object') return out
  for (const [stepId, state] of Object.entries(swarmState)) {
    const normalizedStepId = cleanText(stepId, 64)
    if (!normalizedStepId || !state || typeof state !== 'object') continue
    out[normalizedStepId] = {
      stepId: normalizedStepId,
      workItems: Array.isArray(state.workItems) ? state.workItems : [],
      claims: Array.isArray(state.claims) ? state.claims : [],
      unclaimedItemIds: Array.isArray(state.unclaimedItemIds) ? state.unclaimedItemIds : [],
      eligibleAgentIds: Array.isArray(state.eligibleAgentIds) ? state.eligibleAgentIds : [],
      claimLimitPerAgent: typeof state.claimLimitPerAgent === 'number' ? state.claimLimitPerAgent : 1,
      selectionMode: state.selectionMode === 'claim_until_empty' ? 'claim_until_empty' : 'first_claim',
      claimTimeoutSec: typeof state.claimTimeoutSec === 'number' ? state.claimTimeoutSec : 300,
      openedAt: typeof state.openedAt === 'number' ? state.openedAt : Date.now(),
      closedAt: typeof state.closedAt === 'number' ? state.closedAt : null,
      timedOut: state.timedOut === true,
    }
  }
  return out
}

export function findCurrentStepId(
  steps: ProtocolStepDefinition[],
  preferred: string | null | undefined,
  entryStepId: string | null,
  currentPhaseIndex = 0,
  status?: ProtocolRunStatus,
): string | null {
  const normalized = cleanText(preferred, 64)
  if (normalized && steps.some((step) => step.id === normalized)) return normalized
  if (status === 'completed' || status === 'cancelled' || status === 'archived') return null
  if (Math.trunc(currentPhaseIndex || 0) >= steps.length) return null
  const indexed = steps[Math.max(0, Math.min(Math.trunc(currentPhaseIndex || 0), steps.length - 1))]
  return indexed?.id || entryStepId || null
}

export function findRunStep(run: ProtocolRun, stepId: string | null | undefined): ProtocolStepDefinition | null {
  const normalized = cleanText(stepId, 64)
  if (!normalized || !Array.isArray(run.steps)) return null
  return run.steps.find((step) => step.id === normalized) || null
}

export function protocolLockName(runId: string): string {
  return `protocol:${runId}`
}

export function normalizeProtocolSourceRef(run: Partial<ProtocolRun>): ProtocolSourceRef {
  const sourceRef = run.sourceRef
  if (sourceRef && typeof sourceRef === 'object' && 'kind' in sourceRef) {
    if (sourceRef.kind === 'protocol_run') {
      return {
        kind: 'protocol_run',
        runId: cleanText(sourceRef.runId, 64),
        parentRunId: cleanText(sourceRef.parentRunId, 64) || null,
        stepId: cleanText(sourceRef.stepId, 64) || null,
        branchId: cleanText(sourceRef.branchId, 64) || null,
      }
    }
    return sourceRef
  }
  if (typeof run.parentChatroomId === 'string' && run.parentChatroomId.trim()) {
    return { kind: 'chatroom', chatroomId: run.parentChatroomId.trim() }
  }
  if (typeof run.taskId === 'string' && run.taskId.trim()) {
    return { kind: 'task', taskId: run.taskId.trim() }
  }
  if (typeof run.scheduleId === 'string' && run.scheduleId.trim()) {
    return { kind: 'schedule', scheduleId: run.scheduleId.trim() }
  }
  if (typeof run.sessionId === 'string' && run.sessionId.trim()) {
    return { kind: 'session', sessionId: run.sessionId.trim() }
  }
  return { kind: 'manual' }
}

export function normalizeArtifact(artifact: ProtocolRunArtifact): ProtocolRunArtifact {
  return {
    ...artifact,
    title: cleanText(artifact.title, 120) || 'Artifact',
    content: cleanText(artifact.content, 12_000),
    phaseId: typeof artifact.phaseId === 'string' ? artifact.phaseId : null,
    taskIds: uniqueIds(artifact.taskIds, 32),
  }
}

export function normalizeProtocolRun(run: ProtocolRun): ProtocolRun {
  const { steps, entryStepId } = resolveRunSteps(run)
  const displayPhases = deriveDisplayPhasesFromSteps(steps)
  const currentStepId = findCurrentStepId(steps, run.currentStepId, entryStepId, run.currentPhaseIndex, run.status)
  const currentPhaseIndex = currentStepId
    ? Math.max(0, steps.findIndex((step) => step.id === currentStepId))
    : steps.length
  return {
    ...run,
    sourceRef: normalizeProtocolSourceRef(run),
    participantAgentIds: uniqueIds(run.participantAgentIds, 64),
    observerAgentIds: uniqueIds(run.observerAgentIds, 64),
    facilitatorAgentId: typeof run.facilitatorAgentId === 'string' ? run.facilitatorAgentId : null,
    taskId: typeof run.taskId === 'string' ? run.taskId : null,
    sessionId: typeof run.sessionId === 'string' ? run.sessionId : null,
    parentRunId: typeof run.parentRunId === 'string' ? run.parentRunId : null,
    parentStepId: typeof run.parentStepId === 'string' ? run.parentStepId : null,
    branchId: typeof run.branchId === 'string' ? run.branchId : null,
    parentChatroomId: typeof run.parentChatroomId === 'string' ? run.parentChatroomId : null,
    transcriptChatroomId: typeof run.transcriptChatroomId === 'string' ? run.transcriptChatroomId : null,
    scheduleId: typeof run.scheduleId === 'string' ? run.scheduleId : null,
    systemOwned: run.systemOwned === true,
    waitingReason: cleanText(run.waitingReason, 240) || null,
    pauseReason: cleanText(run.pauseReason, 240) || null,
    lastError: cleanText(run.lastError, 320) || null,
    summary: cleanText(run.summary, 4_000) || null,
    latestArtifactId: typeof run.latestArtifactId === 'string' ? run.latestArtifactId : null,
    artifacts: Array.isArray(run.artifacts) ? run.artifacts.map(normalizeArtifact) : [],
    createdTaskIds: uniqueIds(run.createdTaskIds, 64),
    operatorContext: uniqueIds(run.operatorContext, 32),
    phases: displayPhases,
    steps,
    entryStepId,
    currentStepId,
    config: run.config ? {
      goal: cleanText(run.config.goal, 600) || null,
      kickoffMessage: cleanText(run.config.kickoffMessage, 1_000) || null,
      roundLimit: typeof run.config.roundLimit === 'number' ? run.config.roundLimit : null,
      decisionMode: cleanText(run.config.decisionMode, 120) || null,
      createTranscript: run.config.createTranscript !== false,
      autoEmitTasks: run.config.autoEmitTasks === true,
      taskProjectId: typeof run.config.taskProjectId === 'string' ? run.config.taskProjectId : null,
      postSummaryToParent: run.config.postSummaryToParent !== false,
    } : null,
    phaseState: run.phaseState && typeof run.phaseState === 'object'
      ? {
          phaseId: cleanText(run.phaseState.phaseId, 64),
          respondedAgentIds: uniqueIds(run.phaseState.respondedAgentIds, 64),
          responses: Array.isArray(run.phaseState.responses)
            ? run.phaseState.responses.map((response) => ({
                agentId: cleanText(response.agentId, 64),
                text: cleanText(response.text, 4_000),
                toolEvents: Array.isArray(response.toolEvents) ? response.toolEvents : [],
              }))
            : [],
          appendedToTranscript: run.phaseState.appendedToTranscript === true,
          artifactId: typeof run.phaseState.artifactId === 'string' ? run.phaseState.artifactId : null,
        }
      : null,
    loopState: normalizeLoopState(run.loopState),
    branchHistory: normalizeBranchHistory(run.branchHistory),
    parallelState: normalizeParallelState(run.parallelState),
    stepState: normalizeStepState(run.stepState),
    completedStepIds: Array.isArray(run.completedStepIds) ? run.completedStepIds : [],
    runningStepIds: Array.isArray(run.runningStepIds) ? run.runningStepIds : [],
    readyStepIds: Array.isArray(run.readyStepIds) ? run.readyStepIds : [],
    failedStepIds: Array.isArray(run.failedStepIds) ? run.failedStepIds : [],
    stepOutputs: normalizeStepOutputs(run.stepOutputs),
    forEachState: normalizeForEachState(run.forEachState),
    subflowState: normalizeSubflowState(run.subflowState),
    swarmState: normalizeSwarmState(run.swarmState),
    currentPhaseIndex,
  }
}

export function loadProtocolRunById(runId: string | null | undefined): ProtocolRun | null {
  const normalized = cleanText(runId, 64)
  if (!normalized) return null
  const run = loadProtocolRun(normalized)
  return run ? normalizeProtocolRun(run) : null
}

export function normalizeProtocolTemplate(template: ProtocolTemplate): ProtocolTemplate {
  const { steps, entryStepId } = resolveTemplateSteps(template)
  return {
    ...template,
    id: cleanText(template.id, 64) || genId(8),
    name: cleanText(template.name, 120) || 'Custom Template',
    description: cleanText(template.description, 600) || 'Custom structured-session template.',
    builtIn: template.builtIn === true,
    singleAgentAllowed: template.singleAgentAllowed !== false,
    tags: uniqueIds(template.tags, 24),
    recommendedOutputs: uniqueIds(template.recommendedOutputs, 24),
    defaultPhases: deriveDisplayPhasesFromSteps(steps),
    steps,
    entryStepId,
    createdAt: typeof template.createdAt === 'number' ? template.createdAt : Date.now(),
    updatedAt: typeof template.updatedAt === 'number' ? template.updatedAt : Date.now(),
  }
}
