/**
 * Protocol run lifecycle: create/run/action, scheduling/recovery, launch helpers.
 * Groups G10 + G18 + G19 from protocol-service.ts
 */
import { log } from '@/lib/server/logger'
import { genId } from '@/lib/id'

const TAG = 'protocol-run-lifecycle'
import type {
  ProtocolRun,
  ProtocolRunConfig,
  ProtocolRunStatus,
  ProtocolSourceRef,
  Schedule,
} from '@/types'
import { computeStepReadiness } from '@/lib/server/protocols/dag-scheduler'
import { getAgents } from '@/lib/server/agents/agent-repository'
import { patchChatroom, upsertChatroom } from '@/lib/server/chatrooms/chatroom-repository'
import { loadProtocolRuns } from '@/lib/server/protocols/protocol-run-repository'
import { loadTask } from '@/lib/server/tasks/task-repository'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import { cleanText, isDiscussionStepKind, now, uniqueIds } from '@/lib/server/protocols/protocol-types'
import type { CreateProtocolRunInput, ProtocolRunActionInput, ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import { deriveDisplayPhasesFromSteps, loadProtocolRunById, normalizeProtocolRun, resolveRunSteps } from '@/lib/server/protocols/protocol-normalization'
import { findRunStep } from '@/lib/server/protocols/protocol-normalization'
import { acquireProtocolLease, loadTemplate, renewProtocolLease } from '@/lib/server/protocols/protocol-templates'
import {
  appendProtocolEvent,
  appendTranscriptMessage,
  createTranscriptRoom,
  persistRun,
  updateRun,
} from '@/lib/server/protocols/protocol-agent-turn'
import { claimSwarmWorkItem, syncSwarmClaimCompletion } from '@/lib/server/protocols/protocol-swarm'
import {
  completeProtocolRun,
  currentStep,
  phaseFromStep,
  syncProtocolParentFromChildRun,
} from '@/lib/server/protocols/protocol-step-helpers'
import { stepProtocolRun } from '@/lib/server/protocols/protocol-step-processors'

// ---- Singletons ----

const protocolRecoveryState = hmrSingleton('__swarmclaw_protocol_engine_recovery__', () => ({ completed: false }))
const protocolExecutionState = hmrSingleton('__swarmclaw_protocol_engine_execution__', () => ({
  pendingRunIds: new Set<string>(),
}))

// ---- Scheduling/Recovery (G10) ----

export function requestProtocolRunExecution(runId: string, deps?: ProtocolRunDeps): boolean {
  const normalizedId = cleanText(runId, 64)
  if (!normalizedId) return false
  if (protocolExecutionState.pendingRunIds.has(normalizedId)) return false
  protocolExecutionState.pendingRunIds.add(normalizedId)
  setTimeout(() => {
    void runProtocolRun(normalizedId, deps)
      .catch((err: unknown) => {
        log.warn(TAG, `execution failed for ${normalizedId}: ${errorMessage(err)}`)
      })
      .finally(() => {
        protocolExecutionState.pendingRunIds.delete(normalizedId)
      })
  }, 0)
  return true
}

export function wakeProtocolRunFromTaskCompletion(taskId: string, deps?: ProtocolRunDeps): void {
  const task = loadTask(taskId)
  if (!task?.protocolRunId) return
  const runId = task.protocolRunId
  const run = loadProtocolRunById(runId)
  if (!run || run.status !== 'waiting') return

  // Check if this task is part of a swarm step
  if (run.swarmState) {
    for (const state of Object.values(run.swarmState)) {
      if (state.claims.some((c) => c.taskId === taskId)) {
        syncSwarmClaimCompletion(taskId, deps)
        return
      }
    }
  }

  if (run.phaseState?.dispatchedTaskId !== taskId) return
  const terminalStatuses = ['completed', 'failed', 'cancelled']
  if (!terminalStatuses.includes(task.status)) return
  const phase = run.phaseState?.phaseId ? findRunStep(run, run.phaseState.phaseId) : null
  if (!phase || !isDiscussionStepKind(phase.kind)) return
  const phaseDefinition = phaseFromStep(phase)
  const taskResult = task.status === 'completed' ? 'completed' : task.status
  appendProtocolEvent(runId, {
    type: 'phase_completed',
    phaseId: phaseDefinition.id,
    stepId: phaseDefinition.id,
    summary: `Dispatched task ${taskResult}: ${task.title}`,
    taskId,
  }, deps)
  const step = findRunStep(run, phaseDefinition.id)
  const nextStepId = cleanText(step?.nextStepId, 64) || null
  const nextIndex = nextStepId && Array.isArray(run.steps)
    ? Math.max(0, run.steps.findIndex((entry) => entry.id === nextStepId))
    : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
  persistRun({
    ...run,
    status: 'running',
    waitingReason: null,
    currentStepId: nextStepId,
    currentPhaseIndex: nextIndex,
    phaseState: null,
    updatedAt: now(deps),
  })
  requestProtocolRunExecution(runId, deps)
}

export function ensureProtocolEngineRecovered(deps?: ProtocolRunDeps): void {
  if (protocolRecoveryState.completed) return
  protocolRecoveryState.completed = true
  const runs = Object.values(loadProtocolRuns()).map((entry) => normalizeProtocolRun(entry))
  for (const run of runs) {
    if (run.parentRunId) {
      syncProtocolParentFromChildRun(run, deps)
    }
  }
  for (const run of runs) {
    if (run.status === 'running') {
      appendProtocolEvent(run.id, {
        type: 'recovered',
        summary: 'Recovered an interrupted structured session run after restart.',
      }, deps)
      requestProtocolRunExecution(run.id, deps)
      continue
    }
    if (run.status !== 'waiting') continue
    const hasReadyJoin = Object.values(run.parallelState || {}).some((state) => state.joinReady === true && !state.joinCompletedAt)
    if (hasReadyJoin) {
      appendProtocolEvent(run.id, {
        type: 'recovered',
        summary: 'Recovered a structured session join that was ready to continue after restart.',
      }, deps)
      requestProtocolRunExecution(run.id, deps)
      continue
    }
    // Recover DAG runs: recompute readiness from durable stepState
    if (run.stepState && Object.keys(run.stepState).length > 0) {
      const sched = computeStepReadiness(run.steps || [], run.entryStepId || null, run.stepState)
      if (sched.dagMode && sched.readyStepIds.length > 0) {
        appendProtocolEvent(run.id, {
          type: 'recovered',
          summary: 'Recovered a DAG-mode structured session with ready steps after restart.',
        }, deps)
        requestProtocolRunExecution(run.id, deps)
        continue
      }
    }
    // Recover for_each: check if all branches are terminal
    const forEachStates = Object.values(run.forEachState || {})
    const hasReadyForEach = forEachStates.some((state) => state.joinReady === true && !state.joinCompletedAt)
    if (hasReadyForEach) {
      appendProtocolEvent(run.id, {
        type: 'recovered',
        summary: 'Recovered a for-each join that was ready to continue after restart.',
      }, deps)
      requestProtocolRunExecution(run.id, deps)
      continue
    }
    // Recover subflow: check if child run is terminal
    for (const subState of Object.values(run.subflowState || {})) {
      if (subState.childRunId) {
        const childRun = loadProtocolRunById(subState.childRunId)
        if (childRun && (childRun.status === 'completed' || childRun.status === 'failed' || childRun.status === 'cancelled')) {
          appendProtocolEvent(run.id, {
            type: 'recovered',
            summary: `Recovered subflow step after child run ${childRun.status}.`,
          }, deps)
          requestProtocolRunExecution(run.id, deps)
          break
        }
      }
    }
    // Recover dispatch-waiting runs where the dispatched task has already completed
    const dispatchedTaskId = run.phaseState?.dispatchedTaskId
    if (dispatchedTaskId) {
      const dispatchedTask = loadTask(dispatchedTaskId)
      if (dispatchedTask && ['completed', 'failed', 'cancelled'].includes(dispatchedTask.status)) {
        wakeProtocolRunFromTaskCompletion(dispatchedTaskId, deps)
      }
    }
  }
}

// ---- Create/Run/Action (G18) ----

export function createProtocolRun(input: CreateProtocolRunInput, deps?: ProtocolRunDeps): ProtocolRun {
  const participantAgentIds = uniqueIds(input.participantAgentIds, 64)
  const agents = getAgents(participantAgentIds)
  if (participantAgentIds.length === 0) {
    throw new Error('Structured sessions require at least one participant.')
  }
  const missing = participantAgentIds.filter((agentId) => !agents[agentId])
  if (missing.length > 0) {
    throw new Error(`Unknown participant agent(s): ${missing.join(', ')}`)
  }
  const template = loadTemplate(input.templateId || null)
  const defaultTemplate = loadTemplate('facilitated_discussion')!
  const { steps, entryStepId } = resolveRunSteps({
    steps: Array.isArray(input.steps) && input.steps.length > 0 ? input.steps : template?.steps || [],
    entryStepId: input.entryStepId || template?.entryStepId || null,
    phases: Array.isArray(input.phases) && input.phases.length > 0
      ? input.phases
      : template?.defaultPhases || defaultTemplate.defaultPhases,
  })
  const phases = deriveDisplayPhasesFromSteps(steps)
  const shouldCreateTranscript = input.createTranscript !== false
  const transcript = shouldCreateTranscript
    ? createTranscriptRoom({
        runId: 'pending',
        title: input.title,
        participantAgentIds,
        parentChatroomId: input.parentChatroomId || null,
      }, deps)
    : null
  const sourceRef = input.sourceRef || (
    input.parentChatroomId ? { kind: 'chatroom', chatroomId: input.parentChatroomId } as ProtocolSourceRef
      : input.taskId ? { kind: 'task', taskId: input.taskId } as ProtocolSourceRef
        : input.scheduleId ? { kind: 'schedule', scheduleId: input.scheduleId } as ProtocolSourceRef
          : input.sessionId ? { kind: 'session', sessionId: input.sessionId } as ProtocolSourceRef
            : { kind: 'manual' } as ProtocolSourceRef
  )
  const runId = genId()
  if (transcript) {
    transcript.protocolRunId = runId
    upsertChatroom(transcript.id, transcript)
  }

  const run: ProtocolRun = normalizeProtocolRun({
    id: runId,
    title: cleanText(input.title, 160) || 'Structured Session',
    templateId: template?.id || cleanText(input.templateId, 64) || 'custom',
    templateName: template?.name || 'Custom Structured Session',
    status: input.autoStart === false ? 'draft' : 'running',
    sourceRef,
    participantAgentIds,
    facilitatorAgentId: cleanText(input.facilitatorAgentId, 64) || participantAgentIds[0] || null,
    observerAgentIds: uniqueIds(input.observerAgentIds, 32),
    taskId: cleanText(input.taskId, 64) || null,
    sessionId: cleanText(input.sessionId, 64) || null,
    parentRunId: cleanText(input.parentRunId, 64) || null,
    parentStepId: cleanText(input.parentStepId, 64) || null,
    branchId: cleanText(input.branchId, 64) || null,
    parentChatroomId: cleanText(input.parentChatroomId, 64) || null,
    transcriptChatroomId: transcript?.id || null,
    scheduleId: cleanText(input.scheduleId, 64) || null,
    systemOwned: input.systemOwned === true,
    phases,
    steps,
    entryStepId,
    currentStepId: entryStepId,
    config: {
      ...(input.config || {}),
      createTranscript: shouldCreateTranscript,
      autoEmitTasks: input.config?.autoEmitTasks === true,
    },
    currentPhaseIndex: 0,
    roundNumber: 0,
    artifacts: [],
    createdTaskIds: [],
    waitingReason: null,
    lastError: null,
    phaseState: null,
    createdAt: now(deps),
    updatedAt: now(deps),
    startedAt: input.autoStart === false ? null : now(deps),
    endedAt: null,
    archivedAt: null,
  })

  persistRun(run)
  appendProtocolEvent(run.id, {
    type: 'created',
    summary: `Structured session created from template "${run.templateName}".`,
    data: {
      sourceKind: run.sourceRef.kind,
      transcriptChatroomId: run.transcriptChatroomId,
    },
  }, deps)
  if (input.autoStart !== false) {
    requestProtocolRunExecution(run.id, deps)
  }
  return run
}

export async function runProtocolRun(runId: string, deps?: ProtocolRunDeps): Promise<ProtocolRun | null> {
  const release = acquireProtocolLease(runId)
  if (!release) {
    log.warn(TAG, `could not acquire lease for run ${runId}, another execution may be active`)
    return loadProtocolRunById(runId)
  }
  try {
    let run = loadProtocolRunById(runId)
    if (!run) return null
    if (run.status === 'cancelled' || run.status === 'archived' || run.status === 'completed' || run.status === 'paused') return run
    run = persistRun({
      ...run,
      status: run.status === 'waiting' ? 'running' : run.status,
      waitingReason: null,
      pauseReason: null,
      lastError: null,
      startedAt: run.startedAt || now(deps),
      updatedAt: now(deps),
    })
    if (run.parentRunId) syncProtocolParentFromChildRun(run, deps)

    const MAX_STEP_ITERATIONS = 500
    let stepIterations = 0
    while (run.status === 'running' || run.status === 'draft') {
      stepIterations++
      if (stepIterations > MAX_STEP_ITERATIONS) {
        run = persistRun({ ...run, status: 'failed', lastError: `Exceeded maximum step iterations (${MAX_STEP_ITERATIONS}). Possible infinite loop in step graph.`, updatedAt: now(deps) })
        appendProtocolEvent(run.id, { type: 'failed', summary: `Exceeded maximum step iterations (${MAX_STEP_ITERATIONS}).` }, deps)
        break
      }
      // Yield between steps so I/O, HTTP responses, and timers can run.
      await new Promise(r => setTimeout(r, 0))
      const latest = loadProtocolRunById(run.id)
      if (!latest) return null
      if (latest.status === 'paused' || latest.status === 'cancelled' || latest.status === 'archived' || latest.status === 'completed') {
        run = latest
        break
      }
      run = latest
      renewProtocolLease(run.id)

      // DAG scheduler: compute step readiness before stepping
      const sched = computeStepReadiness(run.steps || [], run.entryStepId || null, run.stepState)
      if (sched.dagMode) {
        run = persistRun({
          ...run,
          stepState: sched.stepState,
          completedStepIds: sched.completedStepIds,
          runningStepIds: sched.runningStepIds,
          readyStepIds: sched.readyStepIds,
          failedStepIds: sched.failedStepIds,
          updatedAt: now(deps),
        })
        if (sched.readyStepIds.length === 0 && sched.runningStepIds.length === 0) {
          // No more work — either all done or stuck
          const allSteps = run.steps || []
          const allCompleted = allSteps.every((s) => sched.stepState[s.id]?.status === 'completed')
          if (allCompleted) {
            run = completeProtocolRun(run, deps)
          } else {
            run = persistRun({ ...run, status: 'failed', lastError: 'DAG stuck: no ready steps and not all completed.', updatedAt: now(deps) })
            appendProtocolEvent(run.id, { type: 'failed', summary: 'DAG stuck: no ready steps and not all completed.' }, deps)
          }
          break
        }
        if (sched.readyStepIds.length > 0) {
          // Pick first ready step as currentStepId
          const nextReadyId = sched.readyStepIds[0]
          run = persistRun({ ...run, currentStepId: nextReadyId, updatedAt: now(deps) })
        }
      }

      run = await stepProtocolRun(run, deps)
      if (run.status === 'waiting' || run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'archived' || run.status === 'completed') break
    }
    if (run.parentRunId) syncProtocolParentFromChildRun(run, deps)
    return run
  } catch (err: unknown) {
    const failed = updateRun(runId, (current) => ({
      ...current,
      status: 'failed',
      lastError: cleanText(errorMessage(err), 320) || 'Structured session failed.',
      endedAt: current.endedAt || now(deps),
      updatedAt: now(deps),
    }))
    appendProtocolEvent(runId, {
      type: 'failed',
      summary: cleanText(errorMessage(err), 320) || 'Structured session failed.',
    }, deps)
    if (failed?.parentRunId) syncProtocolParentFromChildRun(failed, deps)
    return failed
  } finally {
    release()
  }
}

export function performProtocolRunAction(runId: string, input: ProtocolRunActionInput): ProtocolRun | null {
  const run = loadProtocolRunById(runId)
  if (!run) return null
  const action = input.action
  const reason = cleanText(input.reason, 240) || null
  const injectedContext = cleanText(input.context, 4_000) || null
  const activeStep = currentStep(run)
  if (action === 'cancel') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'cancelled',
      endedAt: current.endedAt || Date.now(),
      updatedAt: Date.now(),
    }))
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'cancelled',
        summary: 'Structured session cancelled.',
      })
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'pause') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'paused',
      pauseReason: reason || current.pauseReason || 'Paused by an operator.',
      updatedAt: Date.now(),
    }))
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'paused',
        summary: updated.pauseReason || 'Structured session paused.',
      })
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'archive') {
    const archivedAt = Date.now()
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'archived',
      archivedAt: current.archivedAt || archivedAt,
      updatedAt: archivedAt,
    }))
    if (updated) {
      if (updated.transcriptChatroomId) {
        patchChatroom(updated.transcriptChatroomId, (current) => (
          current
            ? { ...current, archivedAt: current.archivedAt || archivedAt }
            : null
        ))
      }
      appendProtocolEvent(runId, {
        type: 'archived',
        summary: 'Structured session archived.',
      })
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'retry_phase') {
    const updated = updateRun(runId, (current) => ({
      ...current,
      status: 'running',
      waitingReason: null,
      pauseReason: null,
      lastError: null,
      phaseState: null,
      endedAt: null,
      updatedAt: Date.now(),
    }))
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'phase_retried',
        phaseId: activeStep && isDiscussionStepKind(activeStep.kind) ? activeStep.id : null,
        stepId: activeStep?.id || null,
        summary: reason || `Retried the current structured-session ${activeStep ? 'step' : 'phase'}.`,
      })
      requestProtocolRunExecution(runId)
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'skip_phase') {
    const updated = updateRun(runId, (current) => {
      const step = currentStep(current)
      const nextStepId = cleanText(step?.nextStepId, 64) || null
      const nextStatus: ProtocolRunStatus = nextStepId ? 'running' : 'completed'
      return {
        ...current,
        status: nextStatus,
        currentStepId: nextStepId,
        phaseState: null,
        waitingReason: null,
        pauseReason: null,
        lastError: null,
        endedAt: nextStatus === 'completed' ? (current.endedAt || Date.now()) : null,
        updatedAt: Date.now(),
      }
    })
    if (updated) {
      appendProtocolEvent(runId, {
        type: 'phase_skipped',
        phaseId: activeStep && isDiscussionStepKind(activeStep.kind) ? activeStep.id : null,
        stepId: activeStep?.id || null,
        summary: reason || `Skipped the current structured-session ${activeStep ? 'step' : 'phase'}.`,
      })
      if (updated.status === 'completed') {
        const completed = completeProtocolRun(updated, undefined, 'Structured session completed after skipping the final step.')
        if (completed.parentRunId) syncProtocolParentFromChildRun(completed)
        return completed
      } else {
        requestProtocolRunExecution(runId)
      }
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }
  if (action === 'inject_context') {
    if (!injectedContext) return run
    const timestamp = Date.now()
    const updated = updateRun(runId, (current) => ({
      ...current,
      operatorContext: [...(current.operatorContext || []), injectedContext],
      status: current.status === 'waiting' || current.status === 'paused' ? 'running' : current.status,
      waitingReason: current.status === 'waiting' ? null : current.waitingReason,
      pauseReason: current.status === 'paused' ? null : current.pauseReason,
      updatedAt: timestamp,
    }))
    if (updated) {
      if (updated.transcriptChatroomId) {
        appendTranscriptMessage(updated.transcriptChatroomId, {
          senderId: 'system',
          senderName: 'Operator',
          role: 'assistant',
          text: `[Operator context]\n${injectedContext}`,
          mentions: [],
          reactions: [],
          historyExcluded: true,
        })
      }
      appendProtocolEvent(runId, {
        type: 'context_injected',
        summary: 'An operator injected additional structured-session context.',
        data: { context: injectedContext },
      })
      if (updated.status === 'running') {
        requestProtocolRunExecution(runId)
      }
      if (updated.parentRunId) syncProtocolParentFromChildRun(updated)
    }
    return updated
  }

  if (action === 'claim_work') {
    const stepId = cleanText(input.stepId, 64)
    const agentId = cleanText(input.agentId, 64)
    const workItemId = cleanText(input.workItemId, 64)
    if (!stepId || !agentId || !workItemId) return run
    const result = claimSwarmWorkItem(runId, stepId, agentId, workItemId)
    if (!result.success) return run
    return loadProtocolRunById(runId)
  }

  const resumed = updateRun(runId, (current) => ({
    ...current,
    status: 'running',
    waitingReason: null,
    pauseReason: null,
    lastError: null,
    endedAt: null,
    startedAt: current.startedAt || Date.now(),
    updatedAt: Date.now(),
  }))
  if (resumed) {
    appendProtocolEvent(runId, {
      type: 'resumed',
      summary: action === 'start' ? 'Structured session started.' : 'Structured session resumed.',
    })
    requestProtocolRunExecution(runId)
    if (resumed.parentRunId) syncProtocolParentFromChildRun(resumed)
  }
  return resumed
}

// ---- Launch helpers (G19) ----

export function launchProtocolRunForSchedule(schedule: Schedule): ProtocolRun {
  const participantAgentIds = uniqueIds(schedule.protocolParticipantAgentIds, 64)
  const defaultParticipants = participantAgentIds.length > 0 ? participantAgentIds : [schedule.agentId]
  return createProtocolRun({
    title: cleanText(schedule.name, 160) || 'Scheduled Structured Session',
    templateId: schedule.protocolTemplateId || 'single_agent_structured_run',
    participantAgentIds: defaultParticipants,
    facilitatorAgentId: cleanText(schedule.protocolFacilitatorAgentId, 64) || defaultParticipants[0] || null,
    observerAgentIds: uniqueIds(schedule.protocolObserverAgentIds, 32),
    scheduleId: schedule.id,
    sessionId: schedule.createdInSessionId || null,
    sourceRef: { kind: 'schedule', scheduleId: schedule.id },
    autoStart: true,
    parentChatroomId: null,
    config: {
      goal: cleanText(schedule.taskPrompt || schedule.message || schedule.name, 600) || null,
      kickoffMessage: cleanText(schedule.message, 1_000) || null,
      autoEmitTasks: false,
      ...(schedule.protocolConfig || {}),
    },
  })
}

export function launchProtocolRunForTask(input: {
  taskId: string
  title: string
  participantAgentIds: string[]
  facilitatorAgentId?: string | null
  config?: ProtocolRunConfig | null
  templateId?: string | null
}): ProtocolRun {
  return createProtocolRun({
    title: input.title,
    templateId: input.templateId || 'facilitated_discussion',
    participantAgentIds: input.participantAgentIds,
    facilitatorAgentId: input.facilitatorAgentId || null,
    taskId: input.taskId,
    sourceRef: { kind: 'task', taskId: input.taskId },
    config: input.config || null,
  })
}
