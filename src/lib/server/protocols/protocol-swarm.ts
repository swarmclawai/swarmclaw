/**
 * Protocol swarm / self-selection step processing.
 * Group G15 from protocol-service.ts
 */
import { genId } from '@/lib/id'
import type {
  BoardTask,
  ProtocolRun,
  ProtocolRunSwarmState,
  ProtocolStepDefinition,
  ProtocolSwarmConfig,
} from '@/types'
import { loadProtocolRuns } from '@/lib/server/protocols/protocol-run-repository'
import { loadTask, upsertTask } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import { enqueueTask } from '@/lib/server/runtime/queue'
import type * as ProtocolRunLifecycle from '@/lib/server/protocols/protocol-run-lifecycle'
import { now } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import { findRunStep, loadProtocolRunById, normalizeProtocolRun } from '@/lib/server/protocols/protocol-normalization'
import {
  appendProtocolEvent,
  persistRun,
  updateRun,
} from '@/lib/server/protocols/protocol-agent-turn'
import { beginStep } from '@/lib/server/protocols/protocol-step-helpers'

export function resolveSwarmWorkItems(
  run: ProtocolRun,
  config: ProtocolSwarmConfig,
): Array<{ id: string; label: string; description?: string | null }> {
  const source = config.workItemsSource
  if (source.type === 'literal') return source.items
  if (source.type === 'step_output') {
    const output = run.stepOutputs?.[source.stepId]
    if (!output?.structuredData) return []
    const data = source.path
      ? (output.structuredData as Record<string, unknown>)[source.path]
      : output.structuredData
    if (Array.isArray(data)) {
      return data
        .filter((item): item is { id: string; label: string; description?: string | null } =>
          typeof item === 'object' && item !== null && 'id' in item && 'label' in item,
        )
    }
    return []
  }
  return []
}

export async function processSwarmStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const config = step.swarm
  if (!config) {
    throw new Error(`Swarm step "${step.label}" is missing swarm config.`)
  }

  const started = beginStep(run, step, deps)
  const workItems = resolveSwarmWorkItems(started, config)

  if (workItems.length === 0) {
    throw new Error(`Swarm step "${step.label}" resolved zero work items.`)
  }

  const claimLimit = config.claimLimitPerAgent || 1
  const agents = config.eligibleAgentIds
  const claims: import('@/types').ProtocolSwarmClaim[] = []
  const unclaimedItemIds = workItems.map((item) => item.id)
  const createdTaskIds = [...(started.createdTaskIds || [])]

  // Auto-assign: round-robin across eligible agents
  let agentIndex = 0
  const agentClaimCounts = new Map<string, number>()
  for (const agentId of agents) agentClaimCounts.set(agentId, 0)

  for (const workItem of workItems) {
    // Find next agent that hasn't hit their claim limit
    let assigned = false
    for (let attempt = 0; attempt < agents.length; attempt++) {
      const agentId = agents[agentIndex % agents.length]
      agentIndex++
      const currentCount = agentClaimCounts.get(agentId) || 0
      if (currentCount >= claimLimit) continue

      // Create a task for this claim
      const taskId = genId()
      const taskData: BoardTask = {
        id: taskId,
        title: `Swarm: ${workItem.label}`,
        description: workItem.description || `Work item from swarm step "${step.label}"`,
        status: 'queued',
        agentId,
        protocolRunId: started.id,
        sourceType: 'delegation',
        queuedAt: now(deps),
        createdAt: now(deps),
        updatedAt: now(deps),
      }
      upsertTask(taskId, taskData)
      enqueueTask(taskId)
      createdTaskIds.push(taskId)

      claims.push({
        id: genId(),
        workItemId: workItem.id,
        workItemLabel: workItem.label,
        agentId,
        childRunId: null,
        taskId,
        status: 'running',
        claimedAt: now(deps),
        completedAt: null,
      })
      agentClaimCounts.set(agentId, currentCount + 1)
      const idx = unclaimedItemIds.indexOf(workItem.id)
      if (idx >= 0) unclaimedItemIds.splice(idx, 1)
      assigned = true
      break
    }

    if (!assigned) {
      // All agents at capacity for this item — leave it unclaimed
      break
    }
  }

  const swarmState: ProtocolRunSwarmState = {
    stepId: step.id,
    workItems,
    claims,
    unclaimedItemIds,
    eligibleAgentIds: agents,
    claimLimitPerAgent: claimLimit,
    selectionMode: config.selectionMode,
    claimTimeoutSec: config.claimTimeoutSec,
    openedAt: now(deps),
    closedAt: null,
    timedOut: false,
  }

  appendProtocolEvent(run.id, {
    type: 'swarm_opened',
    stepId: step.id,
    summary: `Swarm step "${step.label}" opened with ${workItems.length} work items and ${claims.length} claims.`,
    data: { workItemCount: workItems.length, claimCount: claims.length, eligibleAgents: agents },
  }, deps)

  notify('tasks')

  const updated = persistRun({
    ...started,
    swarmState: {
      ...(started.swarmState || {}),
      [step.id]: swarmState,
    },
    createdTaskIds,
    status: 'waiting',
    waitingReason: `Waiting for ${claims.length} swarm claim${claims.length === 1 ? '' : 's'} to complete.`,
    updatedAt: now(deps),
  })
  return updated
}

export function claimSwarmWorkItem(
  runId: string,
  stepId: string,
  agentId: string,
  workItemId: string,
  deps?: ProtocolRunDeps,
): { success: boolean; error?: string } {
  const run = loadProtocolRunById(runId)
  if (!run) return { success: false, error: 'Run not found' }
  const state = run.swarmState?.[stepId]
  if (!state) return { success: false, error: 'No swarm state for step' }
  if (!state.unclaimedItemIds.includes(workItemId)) return { success: false, error: 'Work item already claimed or invalid' }
  if (!state.eligibleAgentIds.includes(agentId)) return { success: false, error: 'Agent not eligible' }

  const agentClaims = state.claims.filter((c) => c.agentId === agentId).length
  if (agentClaims >= state.claimLimitPerAgent) return { success: false, error: 'Agent at claim limit' }

  const workItem = state.workItems.find((item) => item.id === workItemId)
  if (!workItem) return { success: false, error: 'Work item not found' }

  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: `Swarm: ${workItem.label}`,
    description: workItem.description || '',
    status: 'queued',
    agentId,
    protocolRunId: runId,
    sourceType: 'delegation',
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  enqueueTask(taskId)

  const claim: import('@/types').ProtocolSwarmClaim = {
    id: genId(),
    workItemId,
    workItemLabel: workItem.label,
    agentId,
    childRunId: null,
    taskId,
    status: 'running',
    claimedAt: now(deps),
    completedAt: null,
  }

  const nextUnclaimed = state.unclaimedItemIds.filter((id) => id !== workItemId)
  updateRun(runId, (current) => ({
    ...current,
    swarmState: {
      ...(current.swarmState || {}),
      [stepId]: {
        ...state,
        claims: [...state.claims, claim],
        unclaimedItemIds: nextUnclaimed,
      },
    },
    createdTaskIds: [...(current.createdTaskIds || []), taskId],
    updatedAt: now(deps),
  }))
  appendProtocolEvent(runId, {
    type: 'swarm_claimed',
    stepId,
    summary: `Agent "${agentId}" claimed work item "${workItem.label}".`,
    data: { agentId, workItemId, taskId },
  }, deps)
  notify('tasks')
  return { success: true }
}

export function syncSwarmClaimCompletion(taskId: string, deps?: ProtocolRunDeps): void {
  // Lazy import to avoid circular dependency
  const { requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof ProtocolRunLifecycle
  const task = loadTask(taskId)
  if (!task?.protocolRunId) return
  const run = loadProtocolRunById(task.protocolRunId)
  if (!run) return
  const terminalStatuses = ['completed', 'failed', 'cancelled']
  if (!terminalStatuses.includes(task.status)) return

  for (const [stepId, state] of Object.entries(run.swarmState || {})) {
    const claimIndex = state.claims.findIndex((c) => c.taskId === taskId)
    if (claimIndex < 0) continue

    const claim = state.claims[claimIndex]
    const updatedClaim = {
      ...claim,
      status: (task.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
      completedAt: now(deps),
    }
    const nextClaims = [...state.claims]
    nextClaims[claimIndex] = updatedClaim

    const allTerminal = nextClaims.every((c) => c.status === 'completed' || c.status === 'failed')
    const noUnclaimed = state.unclaimedItemIds.length === 0

    updateRun(run.id, (current) => ({
      ...current,
      swarmState: {
        ...(current.swarmState || {}),
        [stepId]: { ...state, claims: nextClaims },
      },
      updatedAt: now(deps),
    }))

    if (allTerminal && noUnclaimed) {
      appendProtocolEvent(run.id, {
        type: 'swarm_exhausted',
        stepId,
        summary: `All swarm claims completed for step.`,
        data: { completedCount: nextClaims.filter((c) => c.status === 'completed').length, failedCount: nextClaims.filter((c) => c.status === 'failed').length },
      }, deps)

      // Advance parent past the swarm step
      const parentStep = findRunStep(run, stepId)
      if (parentStep && run.status === 'waiting') {
        const nextStepId = parentStep.nextStepId || null
        const nextIndex = nextStepId && Array.isArray(run.steps)
          ? Math.max(0, run.steps.findIndex((s) => s.id === nextStepId))
          : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
        persistRun({
          ...run,
          swarmState: { ...(run.swarmState || {}), [stepId]: { ...state, claims: nextClaims, closedAt: now(deps) } },
          status: 'running',
          currentStepId: nextStepId,
          currentPhaseIndex: nextIndex,
          waitingReason: null,
          updatedAt: now(deps),
        })
        requestProtocolRunExecution(run.id, deps)
      }
    }
    break
  }
}

export function checkSwarmTimeouts(deps?: ProtocolRunDeps): void {
  // Lazy import to avoid circular dependency
  const { requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof ProtocolRunLifecycle
  const runs = Object.values(loadProtocolRuns()).map(normalizeProtocolRun)
  const timestamp = now(deps)
  for (const run of runs) {
    if (run.status !== 'waiting') continue
    for (const [stepId, state] of Object.entries(run.swarmState || {})) {
      if (state.closedAt || state.timedOut) continue
      if (timestamp - state.openedAt < state.claimTimeoutSec * 1000) continue

      // Timed out
      const step = findRunStep(run, stepId)
      const onUnclaimed = step?.swarm?.onUnclaimed || 'fail'

      appendProtocolEvent(run.id, {
        type: 'swarm_exhausted',
        stepId,
        summary: `Swarm step timed out after ${state.claimTimeoutSec}s with ${state.unclaimedItemIds.length} unclaimed items.`,
        data: { unclaimedCount: state.unclaimedItemIds.length, policy: onUnclaimed },
      }, deps)

      if (onUnclaimed === 'fail') {
        persistRun({
          ...run,
          swarmState: { ...(run.swarmState || {}), [stepId]: { ...state, timedOut: true, closedAt: timestamp } },
          status: 'failed',
          lastError: `Swarm step "${step?.label || stepId}" timed out with unclaimed work items.`,
          endedAt: run.endedAt || timestamp,
          updatedAt: timestamp,
        })
      } else {
        // 'advance' or 'fallback_assign'
        const nextStepId = step?.nextStepId || null
        const nextIndex = nextStepId && Array.isArray(run.steps)
          ? Math.max(0, run.steps.findIndex((s) => s.id === nextStepId))
          : Array.isArray(run.steps) ? run.steps.length : run.currentPhaseIndex + 1
        persistRun({
          ...run,
          swarmState: { ...(run.swarmState || {}), [stepId]: { ...state, timedOut: true, closedAt: timestamp } },
          status: 'running',
          currentStepId: nextStepId,
          currentPhaseIndex: nextIndex,
          waitingReason: null,
          updatedAt: timestamp,
        })
        requestProtocolRunExecution(run.id, deps)
      }
    }
  }
}
