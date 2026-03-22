import { checkAgentBudgetLimits } from '@/lib/server/cost'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { log } from '@/lib/server/logger'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import { appendPersistedRunEvent, persistRun } from '@/lib/server/runtime/run-ledger'
import { notify } from '@/lib/server/ws-hub'
import { captureGuardianCheckpoint } from '@/lib/server/agents/guardian'
import {
  assessAutonomyRun,
  executeSupervisorAutoActions,
} from '@/lib/server/autonomy/supervisor-reflection'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import type {
  Agent,
  BoardTask,
  Session,
  SessionRunRecord,
  SessionRunStatus,
} from '@/types'
import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution-types'
import type {
  EnqueueTaskAttemptExecutionRequest,
  ExecutionHandle,
} from '@/lib/server/execution-engine/types'
import { executeExecutionChatTurn } from '@/lib/server/execution-engine/chat-turn'

const TAG = 'execution-engine'

interface TaskAttemptState {
  runningByTaskId: Map<string, ExecutionHandle<ExecuteChatTurnResult>>
}

const taskAttemptState = hmrSingleton<TaskAttemptState>(
  '__swarmclaw_execution_engine_task_attempt__',
  () => ({
    runningByTaskId: new Map<string, ExecutionHandle<ExecuteChatTurnResult>>(),
  }),
)

function messagePreview(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 140)
}

function looksIncomplete(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return true
  if (/(?:^|\n)#{1,3}\s+(?:Step|Phase|Next)\s+\d/i.test(trimmed.slice(-200))) return true
  const lastChunk = trimmed.slice(-300).toLowerCase()
  return /\b(?:next i(?:'ll| will)|now i(?:'ll| will)|let me (?:now|next)|moving on to|proceeding to)\b/.test(lastChunk)
}

function chainCallerSignal(callerSignal: AbortSignal | undefined, controller: AbortController): void {
  if (!callerSignal) return
  if (callerSignal.aborted) {
    controller.abort()
    return
  }
  const onAbort = () => controller.abort()
  callerSignal.addEventListener('abort', onAbort, { once: true })
}

function notifyExecutionState(sessionId: string): void {
  notify('runs')
  notify('sessions')
  notify(`session:${sessionId}`)
}

function emitStatus(run: SessionRunRecord, status: SessionRunStatus, extra?: Record<string, unknown>): void {
  appendPersistedRunEvent({
    runId: run.id,
    sessionId: run.sessionId,
    kind: run.kind,
    ownerType: run.ownerType,
    ownerId: run.ownerId,
    parentExecutionId: run.parentExecutionId,
    phase: 'status',
    status,
    summary: run.resultPreview || run.error || undefined,
    event: {
      t: 'md',
      text: JSON.stringify({
        run: {
          id: run.id,
          sessionId: run.sessionId,
          kind: run.kind,
          ownerType: run.ownerType,
          ownerId: run.ownerId,
          status,
          source: run.source,
          internal: run.internal,
          ...extra,
        },
      }),
    },
  })
  notifyExecutionState(run.sessionId)
}

async function executeTaskAttemptTurn(
  task: BoardTask,
  agent: Agent,
  sessionId: string,
  signal: AbortSignal,
): Promise<ExecuteChatTurnResult> {
  if (agent.autoRecovery) {
    const cwd = task.projectId
      ? `${WORKSPACE_DIR}/projects/${task.projectId}`
      : WORKSPACE_DIR
    captureGuardianCheckpoint(cwd, `task:${task.id}`)
  }

  const settings = loadSettings()
  const basePrompt = task.description || task.title
  const prompt = [
    basePrompt,
    '',
    'Completion requirements:',
    '- Execute the task before replying; do not reply with only a plan.',
    '- Include concrete evidence in your final summary: changed file paths, commands run, and verification results.',
    '- If blocked, state the blocker explicitly and what input or permission is missing.',
  ].join('\n')

  let latestRun = await executeExecutionChatTurn({
    sessionId,
    message: prompt,
    internal: false,
    source: 'task',
    runId: task.id,
    signal,
  })
  let text = typeof latestRun.text === 'string' ? latestRun.text.trim() : ''
  let previousSummary: string | null = null
  let totalInputTokens = latestRun.inputTokens || 0
  let totalOutputTokens = latestRun.outputTokens || 0
  let totalEstimatedCost = Number(latestRun.estimatedCost || 0)

  if (latestRun.error) {
    return {
      ...latestRun,
      text,
    }
  }

  const maxSupervisorFollowups = 2
  for (let followupIndex = 0; followupIndex < maxSupervisorFollowups; followupIndex += 1) {
    if (signal.aborted) break

    const sessions = loadSessions()
    const session = sessions[sessionId] as Session | undefined
    const assessment = assessAutonomyRun({
      runId: `${task.id}:attempt-${(task.attempts || 0) + 1}:step-${followupIndex + 1}`,
      sessionId,
      taskId: task.id,
      agentId: agent.id,
      source: 'task',
      status: latestRun.error ? 'failed' : 'completed',
      resultText: text,
      error: latestRun.error,
      toolEvents: latestRun.toolEvents,
      mainLoopState: {
        followupChainCount: followupIndex + 1,
        summary: previousSummary,
        missionCostUsd: totalEstimatedCost,
      },
      session: session || null,
      settings,
    })
    if (assessment.shouldBlock) break
    if (assessment.autoActions?.length) {
      const result = await executeSupervisorAutoActions({
        actions: assessment.autoActions,
        sessionId,
        agentId: agent.id,
      })
      if (result.blocked) break
    }
    const followupMessage = assessment.interventionPrompt
      || (text && looksIncomplete(text)
        ? 'Continue and complete the remaining steps. Provide a final summary when done.'
        : null)
    if (!followupMessage) break

    if (agent.monthlyBudget || agent.dailyBudget || agent.hourlyBudget) {
      try {
        const followupBudget = checkAgentBudgetLimits(agent)
        if (!followupBudget.ok) {
          log.warn(TAG, `[task_attempt] Budget exceeded for "${agent.name}" during follow-up, stopping.`)
          break
        }
      } catch {
        // Best-effort safety check only.
      }
    }

    previousSummary = text || previousSummary
    const followUp = await executeExecutionChatTurn({
      sessionId,
      message: followupMessage,
      internal: false,
      source: 'task',
      signal,
    })
    totalInputTokens += followUp.inputTokens || 0
    totalOutputTokens += followUp.outputTokens || 0
    totalEstimatedCost += Number(followUp.estimatedCost || 0)
    text = typeof followUp.text === 'string' ? followUp.text.trim() : ''
    latestRun = {
      ...followUp,
      text,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCost: totalEstimatedCost,
    }
    if (latestRun.error) break
  }

  return {
    ...latestRun,
    text,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    estimatedCost: totalEstimatedCost,
  }
}

export function enqueueTaskAttemptExecution(
  input: EnqueueTaskAttemptExecutionRequest,
): ExecutionHandle<ExecuteChatTurnResult> {
  const existing = taskAttemptState.runningByTaskId.get(input.task.id)
  if (existing) return { ...existing, deduped: true }

  const executionId = input.executionId || `${input.task.id}:attempt-${(input.task.attempts || 0) + 1}`
  const controller = new AbortController()
  chainCallerSignal(input.callerSignal, controller)

  const run: SessionRunRecord = {
    id: executionId,
    sessionId: input.sessionId,
    missionId: input.task.missionId || null,
    kind: 'task_attempt',
    ownerType: 'task',
    ownerId: input.task.id,
    parentExecutionId: null,
    recoveryPolicy: 'restart_recoverable',
    source: 'task',
    internal: false,
    mode: 'task_attempt',
    status: 'queued',
    messagePreview: messagePreview(input.task.description || input.task.title),
    queuedAt: Date.now(),
  }

  persistRun(run)
  emitStatus(run, 'queued')

  const promise = (async () => {
    run.status = 'running'
    run.startedAt = Date.now()
    persistRun(run)
    emitStatus(run, 'running')

    try {
      const result = await executeTaskAttemptTurn(input.task, input.agent, input.sessionId, controller.signal)
      run.status = controller.signal.aborted
        ? 'cancelled'
        : (result.error ? 'failed' : 'completed')
      run.endedAt = Date.now()
      run.error = controller.signal.aborted ? (run.error || 'Cancelled') : result.error
      run.resultPreview = result.text?.slice(0, 280)
      if (typeof result.inputTokens === 'number') run.totalInputTokens = result.inputTokens
      if (typeof result.outputTokens === 'number') run.totalOutputTokens = result.outputTokens
      if (typeof result.estimatedCost === 'number') run.estimatedCost = result.estimatedCost
      persistRun(run)
      emitStatus(run, run.status, {
        hasText: !!result.text,
        error: run.error || null,
      })
      return result
    } catch (err: unknown) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'
      run.endedAt = Date.now()
      run.error = errorMessage(err)
      persistRun(run)
      emitStatus(run, run.status, { error: run.error })
      throw err
    } finally {
      const latest = taskAttemptState.runningByTaskId.get(input.task.id)
      if (latest?.executionId === executionId) {
        taskAttemptState.runningByTaskId.delete(input.task.id)
      }
    }
  })()

  const handle: ExecutionHandle<ExecuteChatTurnResult> = {
    executionId,
    promise,
    abort: () => controller.abort(),
  }
  taskAttemptState.runningByTaskId.set(input.task.id, handle)
  return handle
}
