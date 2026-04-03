import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import { errorMessage } from '@/lib/shared-utils'
import { upsertTask } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import { callA2AAgent } from '@/lib/a2a/client'
import { loadExternalAgents } from '@/lib/server/storage'
import { appendProtocolEvent, persistRun } from '@/lib/server/protocols/protocol-agent-turn'
import { now } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import type { ProtocolPhaseDefinition, ProtocolRun, ProtocolRunPhaseState } from '@/types/protocol'
import type { BoardTask } from '@/types/task'

const TAG = 'protocol-a2a-delegate'

/**
 * Process an a2a_delegate phase: call a remote A2A agent and wait for the result.
 *
 * Follows the same pattern as processDispatchDelegationPhase:
 * 1. Create a BoardTask for tracking (with protocolRunId so wakeProtocolRunFromTaskCompletion fires)
 * 2. Call the remote agent via HTTP
 * 3. Set protocol run to 'waiting'
 * 4. When the HTTP call completes, update the task → wake machinery resumes the run
 */
export function processA2ADelegatePhase(
  run: ProtocolRun,
  phase: ProtocolPhaseDefinition,
  deps?: ProtocolRunDeps,
): ProtocolRun {
  const config = phase.a2aDelegateConfig
  if (!config?.taskName || !config?.taskMessage) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `a2a_delegate phase "${phase.label}" missing a2aDelegateConfig`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `a2a_delegate phase "${phase.label}" missing a2aDelegateConfig`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }

  // Resolve target URL
  let targetUrl = config.targetUrl
  if (!targetUrl && config.targetExternalAgentId) {
    const externalAgents = loadExternalAgents()
    const ea = externalAgents[config.targetExternalAgentId]
    if (ea?.endpoint) {
      targetUrl = ea.endpoint
    }
  }

  if (!targetUrl) {
    appendProtocolEvent(run.id, {
      type: 'failed',
      phaseId: phase.id,
      summary: `a2a_delegate phase "${phase.label}" — no target URL resolved`,
    }, deps)
    return persistRun({
      ...run,
      status: 'failed',
      lastError: `a2a_delegate phase "${phase.label}" — could not resolve target A2A agent URL`,
      endedAt: run.endedAt || now(deps),
      updatedAt: now(deps),
    })
  }

  // Create a BoardTask for tracking
  const taskId = genId()
  const taskData: BoardTask = {
    id: taskId,
    title: `A2A: ${config.taskName}`,
    description: config.taskMessage,
    status: 'queued',
    agentId: run.facilitatorAgentId || run.participantAgentIds?.[0] || '',
    protocolRunId: run.id,
    sourceType: 'delegation',
    externalSource: { source: 'a2a', id: taskId },
    queuedAt: now(deps),
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertTask(taskId, taskData)
  notify('tasks')

  appendProtocolEvent(run.id, {
    type: 'delegation_dispatched',
    summary: `Dispatched A2A delegation to ${targetUrl}: ${config.taskName}`,
    phaseId: phase.id,
    taskId,
  }, deps)

  log.info(TAG, `Calling remote A2A agent at ${targetUrl}`, { taskName: config.taskName, taskId })

  // Fire the HTTP call asynchronously — when it completes, update the task
  // The existing wakeProtocolRunFromTaskCompletion machinery will resume the run
  const resolvedUrl = targetUrl
  callA2AAgent(resolvedUrl, 'executeTask', {
    taskId,
    taskName: config.taskName,
    message: config.taskMessage,
  }, {
    timeout: config.timeoutMs ?? 300_000,
    credentialId: config.credentialId,
  }).then(result => {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
    upsertTask(taskId, { ...taskData, status: 'completed', result: resultStr, updatedAt: Date.now(), completedAt: Date.now() })
    notify('tasks')
    log.info(TAG, `A2A delegation completed for task ${taskId}`)
    // Dynamic import to break circular dependency (protocol-step-processors → protocol-a2a-delegate → protocol-run-lifecycle → protocol-step-processors)
    import('@/lib/server/protocols/protocol-run-lifecycle').then(m => m.wakeProtocolRunFromTaskCompletion(taskId))
  }).catch(err => {
    log.error(TAG, `A2A delegation failed for task ${taskId}: ${errorMessage(err)}`)
    if (config.onFailure === 'advance_with_warning') {
      upsertTask(taskId, { ...taskData, status: 'completed', result: `A2A delegation failed: ${errorMessage(err)}`, error: errorMessage(err), updatedAt: Date.now(), completedAt: Date.now() })
    } else {
      upsertTask(taskId, { ...taskData, status: 'failed', error: errorMessage(err), updatedAt: Date.now() })
    }
    notify('tasks')
    import('@/lib/server/protocols/protocol-run-lifecycle').then(m => m.wakeProtocolRunFromTaskCompletion(taskId))
  })

  const createdTaskIds = [...(run.createdTaskIds || []), taskId]
  return persistRun({
    ...run,
    status: 'waiting',
    waitingReason: `Waiting for A2A delegation: ${config.taskName}`,
    createdTaskIds,
    phaseState: { ...(run.phaseState || { phaseId: phase.id }), dispatchedTaskId: taskId } as ProtocolRunPhaseState,
    updatedAt: now(deps),
  })
}
