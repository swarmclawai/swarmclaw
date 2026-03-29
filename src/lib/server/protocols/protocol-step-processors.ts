/**
 * Protocol step processors + dispatcher.
 * Groups G12 + G16 from protocol-service.ts
 */
import { genId } from '@/lib/id'
import type {
  BoardTask,
  ProtocolPhaseDefinition,
  ProtocolRun,
  ProtocolRunArtifact,
  ProtocolRunParallelBranchState,
  ProtocolRunPhaseState,
  ProtocolStepDefinition,
} from '@/types'
import { errorMessage } from '@/lib/shared-utils'
import { getAgents } from '@/lib/server/agents/agent-repository'
import { upsertTask } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { cleanText, isDiscussionStepKind, now, uniqueIds } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import type * as ProtocolRunLifecycle from '@/lib/server/protocols/protocol-run-lifecycle'
import { processForEachStep } from '@/lib/server/protocols/protocol-foreach'
import { processSubflowStep } from '@/lib/server/protocols/protocol-subflow'
import { processSwarmStep } from '@/lib/server/protocols/protocol-swarm'
import { findRunStep } from '@/lib/server/protocols/protocol-normalization'
import {
  appendProtocolEvent,
  appendTranscriptMessage,
  buildPhasePrompt,
  chooseFacilitator,
  createArtifact,
  defaultExecuteAgentTurn,
  defaultExtractActionItems,
  persistRun,
} from '@/lib/server/protocols/protocol-agent-turn'
import { renewProtocolLease } from '@/lib/server/protocols/protocol-templates'
import {
  appendArtifact,
  beginPhase,
  beginStep,
  buildParallelBranchGoal,
  buildParallelBranchRunTitle,
  buildParallelBranchState,
  buildParallelStepState,
  completeProtocolRun,
  currentArtifact,
  currentStep,
  defaultDecideBranchCase,
  evaluateProtocolCondition,
  findParallelStepIdForJoin,
  finishPhase,
  finishStep,
  phaseFromStep,
} from '@/lib/server/protocols/protocol-step-helpers'

// ---- Step Processors (G12) ----

export async function processPresentPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const kickoff = cleanText(run.config?.kickoffMessage, 1_000)
  const goal = cleanText(run.config?.goal, 600) || cleanText(run.title, 220)
  if (run.transcriptChatroomId && !(run.phaseState?.appendedToTranscript === true)) {
    appendTranscriptMessage(run.transcriptChatroomId, {
      senderId: 'system',
      senderName: 'System',
      role: 'assistant',
      text: [
        `Structured session: ${run.title}`,
        `Objective: ${goal}`,
        kickoff ? `Context: ${kickoff}` : '',
        phase.instructions ? `Notes: ${phase.instructions}` : '',
      ].filter(Boolean).join('\n'),
      mentions: [],
      reactions: [],
    }, deps)
    run = persistRun({
      ...run,
      phaseState: run.phaseState ? { ...run.phaseState, appendedToTranscript: true } : run.phaseState,
      updatedAt: now(deps),
    })
  }
  return finishPhase(run, phase, deps)
}

export async function collectResponses(
  run: ProtocolRun,
  phase: ProtocolPhaseDefinition,
  appendImmediately: boolean,
  deps?: ProtocolRunDeps,
): Promise<ProtocolRun> {
  const executeAgentTurn = deps?.executeAgentTurn || defaultExecuteAgentTurn
  let current = run
  const responded = new Set(current.phaseState?.respondedAgentIds || [])
  const cachedResponses = Array.isArray(current.phaseState?.responses) ? [...current.phaseState.responses] : []
  const participantAgents = getAgents(current.participantAgentIds)

  for (const agentId of current.participantAgentIds) {
    if (responded.has(agentId)) continue
    renewProtocolLease(current.id)
    let response: { text: string; toolEvents: import('@/types').MessageToolEvent[] }
    try {
      response = await executeAgentTurn({
        run: current,
        phase,
        agentId,
        prompt: buildPhasePrompt(current, phase, agentId),
      })
    } catch (err: unknown) {
      const errMsg = cleanText(errorMessage(err), 200) || 'unknown error'
      appendProtocolEvent(current.id, {
        type: 'warning',
        phaseId: phase.id,
        agentId,
        summary: `Agent ${agentId} failed during phase "${phase.label}": ${errMsg}`,
      }, deps)
      response = { text: `[Agent error: ${errMsg}]`, toolEvents: [] }
    }
    responded.add(agentId)
    cachedResponses.push({ agentId, text: response.text, toolEvents: response.toolEvents })
    current = persistRun({
      ...current,
      phaseState: {
        phaseId: phase.id,
        respondedAgentIds: Array.from(responded),
        responses: cachedResponses,
        appendedToTranscript: appendImmediately ? true : false,
        artifactId: current.phaseState?.artifactId || null,
      },
      updatedAt: now(deps),
    })
    if (appendImmediately && current.transcriptChatroomId) {
      appendTranscriptMessage(current.transcriptChatroomId, {
        senderId: agentId,
        senderName: participantAgents[agentId]?.name || agentId,
        role: 'assistant',
        text: response.text,
        mentions: [],
        reactions: [],
        ...(response.toolEvents.length > 0 ? { toolEvents: response.toolEvents } : {}),
      }, deps)
      appendProtocolEvent(current.id, {
        type: 'participant_response',
        phaseId: phase.id,
        agentId,
        summary: `Captured a response from ${participantAgents[agentId]?.name || agentId}.`,
      }, deps)
    }
  }

  if (!appendImmediately && current.transcriptChatroomId && current.phaseState?.appendedToTranscript !== true) {
    for (const response of cachedResponses) {
      appendTranscriptMessage(current.transcriptChatroomId, {
        senderId: response.agentId,
        senderName: participantAgents[response.agentId]?.name || response.agentId,
        role: 'assistant',
        text: response.text,
        mentions: [],
        reactions: [],
        ...(response.toolEvents && response.toolEvents.length > 0 ? { toolEvents: response.toolEvents } : {}),
      }, deps)
      appendProtocolEvent(current.id, {
        type: 'participant_response',
        phaseId: phase.id,
        agentId: response.agentId,
        summary: `Captured an independent response from ${participantAgents[response.agentId]?.name || response.agentId}.`,
      }, deps)
    }
    current = persistRun({
      ...current,
      phaseState: current.phaseState
        ? { ...current.phaseState, appendedToTranscript: true }
        : current.phaseState,
      updatedAt: now(deps),
    })
  }
  return finishPhase(current, phase, deps)
}

export async function processFacilitatorArtifactPhase(
  run: ProtocolRun,
  phase: ProtocolPhaseDefinition,
  kind: ProtocolRunArtifact['kind'],
  deps?: ProtocolRunDeps,
): Promise<ProtocolRun> {
  const facilitatorId = chooseFacilitator(run)
  if (!facilitatorId) {
    throw new Error('Structured session has no facilitator or participants to continue.')
  }
  if (run.phaseState?.artifactId) {
    return finishPhase(run, phase, deps)
  }
  const executeAgentTurn = deps?.executeAgentTurn || defaultExecuteAgentTurn
  renewProtocolLease(run.id)
  const result = await executeAgentTurn({
    run,
    phase,
    agentId: facilitatorId,
    prompt: buildPhasePrompt(run, phase, facilitatorId),
  })
  const artifact = createArtifact(run, phase, kind, phase.label, result.text, deps)
  const agents = getAgents([facilitatorId])
  if (run.transcriptChatroomId) {
    appendTranscriptMessage(run.transcriptChatroomId, {
      senderId: facilitatorId,
      senderName: agents[facilitatorId]?.name || facilitatorId,
      role: 'assistant',
      text: result.text,
      mentions: [],
      reactions: [],
      ...(result.toolEvents.length > 0 ? { toolEvents: result.toolEvents } : {}),
    }, deps)
  }
  const updated = appendArtifact(run, artifact, deps)
  return finishPhase(updated, phase, deps)
}

export async function processEmitTasksPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  if (run.phaseState?.artifactId) return finishPhase(run, phase, deps)
  const artifact = currentArtifact(run)
  if (!artifact) return finishPhase(run, phase, deps)
  const extractActionItems = deps?.extractActionItems || defaultExtractActionItems
  const extracted = await extractActionItems({ run, phase, artifact })
  const fallbackAssignee = chooseFacilitator(run) || run.participantAgentIds[0] || ''
  const agents = getAgents(uniqueIds([
    fallbackAssignee,
    ...extracted.map((item) => item.agentId || ''),
  ], 64))
  const createdTaskIds: string[] = []
  const taskProjectId = run.config?.taskProjectId || null
  for (const item of extracted) {
    const assignedAgentId = item.agentId && agents[item.agentId] ? item.agentId : fallbackAssignee
    if (!assignedAgentId) continue
    const task: BoardTask = {
      id: genId(),
      title: cleanText(item.title, 160),
      description: cleanText(item.description, 1_000) || cleanText(artifact.content, 800),
      status: 'backlog',
      agentId: assignedAgentId,
      projectId: taskProjectId || undefined,
      createdByAgentId: chooseFacilitator(run),
      createdInSessionId: run.sessionId || null,
      createdAt: now(deps),
      updatedAt: now(deps),
      sourceType: 'manual',
      tags: ['structured-session'],
    }
    upsertTask(task.id, task)
    createdTaskIds.push(task.id)
    appendProtocolEvent(run.id, {
      type: 'task_emitted',
      phaseId: phase.id,
      taskId: task.id,
      summary: `Created task: ${task.title}`,
      data: { agentId: assignedAgentId },
    }, deps)
  }
  const updated = persistRun({
    ...run,
    createdTaskIds: [...(run.createdTaskIds || []), ...createdTaskIds],
    phaseState: run.phaseState
      ? { ...run.phaseState, artifactId: artifact.id }
      : run.phaseState,
    updatedAt: now(deps),
  })
  if (createdTaskIds.length > 0) notify('tasks')
  return finishPhase(updated, phase, deps)
}

export function processWaitPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const step = findRunStep(run, phase.id)
  const nextStepId = cleanText(step?.nextStepId, 64) || null
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  const waitReason = cleanText(phase.instructions, 240) || 'Structured session is waiting for a manual resume.'
  appendProtocolEvent(run.id, {
    type: 'waiting',
    phaseId: phase.id,
    stepId: phase.id,
    summary: waitReason,
  }, deps)
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: waitReason,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    phaseState: null,
    updatedAt: now(deps),
  })
}

export async function processBranchStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const started = beginStep(run, step, deps)
  const cases = Array.isArray(step.branchCases) ? step.branchCases : []
  const deterministic = cases.find((branchCase) => branchCase.when && evaluateProtocolCondition(started, branchCase.when))
  const decider = deps?.decideBranchCase || (async ({ run: decisionRun, step: decisionStep, cases: decisionCases }) => (
    defaultDecideBranchCase(decisionRun, decisionStep, decisionCases)
  ))
  const decided = deterministic
    ? { caseId: deterministic.id, nextStepId: deterministic.nextStepId }
    : await decider({ run: started, step, cases })
  const nextStepId = cleanText(decided?.nextStepId || step.defaultNextStepId, 64) || null
  const caseId = cleanText(decided?.caseId, 64) || null
  if (!nextStepId) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `Branch "${step.label}" could not resolve a path. Cases: ${cases.length}, LLM result: ${decided ? `caseId=${decided.caseId}` : 'null'}, defaultNextStepId: ${step.defaultNextStepId || 'none'}`,
    }, deps)
    throw new Error(`Structured session branch "${step.label}" had no satisfied path.`)
  }
  appendProtocolEvent(run.id, {
    type: 'branch_taken',
    stepId: step.id,
    summary: caseId
      ? `Branch "${step.label}" selected case ${caseId}.`
      : `Branch "${step.label}" took its default path.`,
    data: { caseId, nextStepId },
  }, deps)
  const updated = persistRun({
    ...started,
    branchHistory: [
      ...(started.branchHistory || []),
      { stepId: step.id, caseId, nextStepId, decidedAt: now(deps) },
    ],
    updatedAt: now(deps),
  })
  return finishStep(updated, step, nextStepId, deps)
}

export async function processRepeatStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const repeat = step.repeat
  if (!repeat?.bodyStepId) {
    throw new Error(`Repeat step "${step.label}" is missing a body step.`)
  }
  const started = beginStep(run, step, deps)
  const currentLoop = started.loopState?.[step.id] || { stepId: step.id, iterationCount: 0 }
  const explicitDecision = deps?.decideRepeatContinuation
    ? await deps.decideRepeatContinuation({
        run: started,
        step,
        repeat,
        iterationCount: currentLoop.iterationCount,
      })
    : null
  const shouldExit = explicitDecision === 'exit'
    || (explicitDecision !== 'continue' && evaluateProtocolCondition(started, repeat.exitCondition))
  const nextAfterRepeat = cleanText(repeat.nextStepId || step.nextStepId, 64) || null
  if (shouldExit) {
    return finishStep(started, step, nextAfterRepeat, deps)
  }
  if (currentLoop.iterationCount >= repeat.maxIterations) {
    appendProtocolEvent(run.id, {
      type: 'loop_exhausted',
      stepId: step.id,
      summary: `Loop "${step.label}" exhausted its ${repeat.maxIterations} iteration limit.`,
      data: { maxIterations: repeat.maxIterations, onExhausted: repeat.onExhausted || 'fail' },
    }, deps)
    if (repeat.onExhausted === 'advance') {
      return finishStep(started, step, nextAfterRepeat, deps)
    }
    throw new Error(`Structured session loop "${step.label}" exhausted its iteration limit.`)
  }
  const nextIteration = currentLoop.iterationCount + 1
  appendProtocolEvent(run.id, {
    type: 'loop_iteration_started',
    stepId: step.id,
    summary: `Started loop iteration ${nextIteration} for ${step.label}.`,
    data: { iterationCount: nextIteration, bodyStepId: repeat.bodyStepId },
  }, deps)
  const updated = persistRun({
    ...started,
    loopState: {
      ...(started.loopState || {}),
      [step.id]: {
        stepId: step.id,
        iterationCount: nextIteration,
      },
    },
    updatedAt: now(deps),
  })
  return finishStep(updated, step, cleanText(repeat.bodyStepId, 64) || null, deps)
}

function buildJoinArtifactContent(branches: ProtocolRunParallelBranchState[]): string {
  const lines = ['Parallel branch results:']
  for (const branch of branches) {
    lines.push('')
    lines.push(`- ${branch.label} (${branch.status})`)
    if (branch.summary) lines.push(`  ${branch.summary}`)
    else if (branch.lastError) lines.push(`  ${branch.lastError}`)
  }
  return lines.join('\n')
}

export async function processParallelStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  // Lazy import to avoid circular dependency
  const { createProtocolRun, requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof ProtocolRunLifecycle
  const parallel = step.parallel
  if (!parallel?.branches?.length) {
    throw new Error(`Parallel step "${step.label}" is missing branches.`)
  }
  const joinStepId = cleanText(step.nextStepId, 64)
  if (!joinStepId) {
    throw new Error(`Parallel step "${step.label}" is missing a join step.`)
  }
  const joinStep = findRunStep(run, joinStepId)
  if (!joinStep || joinStep.kind !== 'join') {
    throw new Error(`Parallel step "${step.label}" must point to an explicit join step.`)
  }
  const started = beginStep(run, step, deps)
  const branches: ProtocolRunParallelBranchState[] = []
  appendProtocolEvent(run.id, {
    type: 'parallel_started',
    stepId: step.id,
    summary: `Started parallel step "${step.label}" with ${parallel.branches.length} branches.`,
    data: { joinStepId, branchCount: parallel.branches.length },
  }, deps)

  for (const branch of parallel.branches) {
    const participantAgentIds = uniqueIds(
      Array.isArray(branch.participantAgentIds) && branch.participantAgentIds.length > 0
        ? branch.participantAgentIds
        : started.participantAgentIds,
      64,
    )
    const childRun = createProtocolRun({
      title: buildParallelBranchRunTitle(started, step, branch),
      templateId: 'custom',
      steps: branch.steps,
      entryStepId: branch.entryStepId || branch.steps[0]?.id || null,
      participantAgentIds,
      facilitatorAgentId: cleanText(branch.facilitatorAgentId, 64) || participantAgentIds[0] || null,
      observerAgentIds: uniqueIds(branch.observerAgentIds, 32),
      sessionId: started.sessionId || null,
      sourceRef: {
        kind: 'protocol_run',
        runId: started.id,
        parentRunId: started.id,
        stepId: step.id,
        branchId: branch.id,
      },
      autoStart: false,
      createTranscript: true,
      config: {
        ...(started.config || {}),
        goal: buildParallelBranchGoal(started, step, branch),
        postSummaryToParent: false,
      },
      parentRunId: started.id,
      parentStepId: step.id,
      branchId: branch.id,
      systemOwned: true,
    }, deps)
    const branchState = buildParallelBranchState(childRun, {
      branchId: branch.id,
      label: branch.label,
      runId: childRun.id,
      participantAgentIds,
    })
    branches.push(branchState)
    appendProtocolEvent(run.id, {
      type: 'parallel_branch_spawned',
      stepId: step.id,
      summary: `Spawned branch "${branch.label}".`,
      data: { branchId: branch.id, childRunId: childRun.id, participantAgentIds },
    }, deps)
  }

  const parallelState = buildParallelStepState(step.id, branches)
  const progressed = finishStep(persistRun({
    ...started,
    parallelState: {
      ...(started.parallelState || {}),
      [step.id]: parallelState,
    },
    updatedAt: now(deps),
  }), step, joinStepId, deps)
  const updated = persistRun({
    ...progressed,
    status: 'waiting',
    waitingReason: `Waiting for ${parallel.branches.length} parallel branch${parallel.branches.length === 1 ? '' : 'es'} to finish before joining.`,
    updatedAt: now(deps),
  })
  for (const branch of branches) {
    requestProtocolRunExecution(branch.runId, deps)
  }
  return updated
}

export async function processJoinStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const started = beginStep(run, step, deps)
  const parallelStepId = findParallelStepIdForJoin(started, step)
  if (!parallelStepId) {
    throw new Error(`Join step "${step.label}" could not resolve its parallel source step.`)
  }
  const parallelState = started.parallelState?.[parallelStepId]
  if (!parallelState) {
    throw new Error(`Join step "${step.label}" has no recorded parallel state.`)
  }
  if (!parallelState.joinReady) {
    return persistRun({
      ...started,
      status: 'waiting',
      waitingReason: `Waiting for ${parallelState.waitingOnBranchIds?.length || 0} parallel branch${parallelState.waitingOnBranchIds?.length === 1 ? '' : 'es'} to finish before joining.`,
      updatedAt: now(deps),
    })
  }
  const failedBranches = parallelState.branches.filter((branch) => branch.status !== 'completed')
  if (failedBranches.length > 0 && failedBranches.length === parallelState.branches.length) {
    throw new Error(`Structured session join "${step.label}" could not continue because all ${failedBranches.length} branch${failedBranches.length === 1 ? '' : 'es'} failed or stopped.`)
  }
  if (failedBranches.length > 0) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `Join "${step.label}" continuing with partial results: ${failedBranches.length} of ${parallelState.branches.length} branch(es) did not complete.`,
    }, deps)
  }
  const artifact = {
    id: genId(),
    kind: 'notes' as const,
    title: `${step.label} branch merge`,
    content: buildJoinArtifactContent(parallelState.branches),
    phaseId: step.id,
    createdAt: now(deps),
  }
  appendProtocolEvent(run.id, {
    type: 'artifact_emitted',
    stepId: step.id,
    artifactId: artifact.id,
    summary: `Recorded the merged output for ${step.label}.`,
  }, deps)
  appendProtocolEvent(run.id, {
    type: 'join_completed',
    stepId: step.id,
    summary: `Joined ${parallelState.branches.length} parallel branches.`,
    data: { parallelStepId, artifactId: artifact.id },
  }, deps)
  if (started.transcriptChatroomId) {
    appendTranscriptMessage(started.transcriptChatroomId, {
      senderId: 'system',
      senderName: 'Structured Session',
      role: 'assistant',
      text: artifact.content,
      mentions: [],
      reactions: [],
    }, deps)
  }
  const updated = persistRun({
    ...started,
    artifacts: [...(started.artifacts || []), artifact],
    latestArtifactId: artifact.id,
    parallelState: {
      ...(started.parallelState || {}),
      [parallelStepId]: {
        ...parallelState,
        joinCompletedAt: now(deps),
      },
    },
    updatedAt: now(deps),
  })
  return finishStep(updated, step, cleanText(step.nextStepId, 64) || null, deps)
}

export function processDispatchTaskPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const config = phase.taskConfig
  if (!config?.title) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `dispatch_task phase "${phase.label}" has no taskConfig.title`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `dispatch_task phase "${phase.label}" has no taskConfig.title`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }
  const agentId = config.agentId || run.facilitatorAgentId || run.participantAgentIds[0] || ''
  if (!agentId) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `dispatch_task phase "${phase.label}" has no agentId`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `dispatch_task phase "${phase.label}" has no agentId`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }
  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: config.title,
    description: config.description || '',
    status: 'queued',
    agentId,
    protocolRunId: run.id,
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  enqueueTask(taskId)
  const createdTaskIds = [...(run.createdTaskIds || []), taskId]
  appendProtocolEvent(run.id, {
    type: 'task_dispatched',
    summary: `Dispatched task: ${config.title}`,
    phaseId: phase.id,
    taskId,
  }, deps)
  notify('tasks')
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: `Waiting for task: ${config.title}`,
    createdTaskIds,
    phaseState: { ...(run.phaseState || { phaseId: phase.id }), dispatchedTaskId: taskId } as ProtocolRunPhaseState,
    updatedAt: now(deps),
  })
}

export function processDispatchDelegationPhase(run: ProtocolRun, phase: ProtocolPhaseDefinition, deps?: ProtocolRunDeps): ProtocolRun {
  const config = phase.delegationConfig
  if (!config?.agentId || !config?.message) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `dispatch_delegation phase "${phase.label}" missing delegationConfig`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `dispatch_delegation phase "${phase.label}" missing delegationConfig`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }
  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: `Delegation: ${phase.label}`,
    description: config.message,
    status: 'queued',
    agentId: config.agentId,
    protocolRunId: run.id,
    sourceType: 'delegation',
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  enqueueTask(taskId)
  const createdTaskIds = [...(run.createdTaskIds || []), taskId]
  appendProtocolEvent(run.id, {
    type: 'delegation_dispatched',
    summary: `Dispatched delegation to agent: ${config.agentId}`,
    phaseId: phase.id,
    taskId,
  }, deps)
  notify('tasks')
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: `Waiting for delegation: ${phase.label}`,
    createdTaskIds,
    phaseState: { ...(run.phaseState || { phaseId: phase.id }), dispatchedTaskId: taskId } as ProtocolRunPhaseState,
    updatedAt: now(deps),
  })
}

// ---- Dispatcher (G16) ----

export async function stepProtocolRun(run: ProtocolRun, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const step = currentStep(run)
  if (!step) {
    return completeProtocolRun(run, deps)
  }
  if (isDiscussionStepKind(step.kind)) {
    const phase = phaseFromStep(step)
    const started = beginPhase(run, phase, deps)
    if (phase.kind === 'present') return processPresentPhase(started, phase, deps)
    if (phase.kind === 'collect_independent_inputs') return collectResponses(started, phase, false, deps)
    if (phase.kind === 'round_robin') return collectResponses(started, phase, true, deps)
    if (phase.kind === 'compare') return processFacilitatorArtifactPhase(started, phase, 'comparison', deps)
    if (phase.kind === 'decide') return processFacilitatorArtifactPhase(started, phase, 'decision', deps)
    if (phase.kind === 'summarize') return processFacilitatorArtifactPhase(started, phase, 'summary', deps)
    if (phase.kind === 'emit_tasks') return processEmitTasksPhase(started, phase, deps)
    if (phase.kind === 'dispatch_task') return processDispatchTaskPhase(started, phase, deps)
    if (phase.kind === 'dispatch_delegation') return processDispatchDelegationPhase(started, phase, deps)
    return processWaitPhase(started, phase, deps)
  }
  if (step.kind === 'branch') return processBranchStep(run, step, deps)
  if (step.kind === 'repeat') return processRepeatStep(run, step, deps)
  if (step.kind === 'parallel') return processParallelStep(run, step, deps)
  if (step.kind === 'join') return processJoinStep(run, step, deps)
  if (step.kind === 'for_each') return processForEachStep(run, step, deps)
  if (step.kind === 'subflow') return processSubflowStep(run, step, deps)
  if (step.kind === 'swarm_claim') return processSwarmStep(run, step, deps)
  if (step.kind === 'complete') {
    const started = beginStep(run, step, deps)
    const finished = finishStep(started, step, null, deps)
    return completeProtocolRun(finished, deps)
  }
  throw new Error(`Unsupported structured-session step kind: ${step.kind}`)
}
