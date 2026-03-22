import { executeExecutionChatTurn } from '@/lib/server/execution-engine/chat-turn'
import { log } from '@/lib/server/logger'
import { isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'
import { notify } from '@/lib/server/ws-hub'
import { errorMessage } from '@/lib/shared-utils'
import { handleMainLoopRunResult } from '@/lib/server/agents/main-agent-loop'

import {
  clearDeferredDrain,
  decrementNonHeartbeatWork,
  emitRunMeta,
  emitToSubscribers,
  hasActiveNonHeartbeatSessionLease,
  hasExternalSessionExecutionHold,
  HEARTBEAT_BUSY_RETRY_MS,
  MAX_DRAIN_DEPTH,
  now,
  queueAutonomyObservation,
  queueForExecution,
  reconcileSessionActivityLease,
  scheduleDeferredDrain,
  state,
  syncRunRecord,
} from './state'
import type { EnqueueSessionRunInput } from './types'

type EnqueueSessionRunFn = (input: EnqueueSessionRunInput) => unknown

export async function drainExecution(
  executionKey: string,
  deps: { enqueueSessionRun: EnqueueSessionRunFn },
): Promise<void> {
  const depth = (state.drainDepth.get(executionKey) || 0) + 1
  state.drainDepth.set(executionKey, depth)
  if (depth > MAX_DRAIN_DEPTH) {
    log.error('session-run', 'Drain recursion depth exceeded, deferring', { executionKey, depth, max: MAX_DRAIN_DEPTH })
    state.drainDepth.delete(executionKey)
    scheduleDeferredDrain(executionKey, (nextExecutionKey) => { void drainExecution(nextExecutionKey, deps) }, 500)
    return
  }
  try {
    if (state.runningByExecution.has(executionKey)) return
    const queue = queueForExecution(executionKey)
    const userIdx = queue.findIndex((entry) => !entry.run.internal)
    let next
    if (userIdx >= 0) {
      next = queue.splice(userIdx, 1)[0]
    } else {
      const internalIdx = queue.findIndex((entry) => !isInternalHeartbeatRun(entry.run.internal, entry.run.source))
      next = internalIdx >= 0 ? queue.splice(internalIdx, 1)[0] : queue.shift()
    }
    if (!next) {
      clearDeferredDrain(executionKey)
      return
    }

    if (isInternalHeartbeatRun(next.run.internal, next.run.source) && hasActiveNonHeartbeatSessionLease(next.run.sessionId)) {
      queue.unshift(next)
      scheduleDeferredDrain(executionKey, (nextExecutionKey) => { void drainExecution(nextExecutionKey, deps) }, HEARTBEAT_BUSY_RETRY_MS)
      log.info('session-run', `Deferred heartbeat run ${next.run.id} for shared busy session`, {
        sessionId: next.run.sessionId,
        source: next.run.source,
      })
      return
    }

    if (hasExternalSessionExecutionHold(next.run.sessionId)) {
      queue.unshift(next)
      scheduleDeferredDrain(executionKey, (nextExecutionKey) => { void drainExecution(nextExecutionKey, deps) }, HEARTBEAT_BUSY_RETRY_MS)
      log.info('session-run', `Deferred run ${next.run.id} for external session hold`, {
        sessionId: next.run.sessionId,
        source: next.run.source,
        mode: next.run.mode,
      })
      return
    }

    clearDeferredDrain(executionKey)
    state.runningByExecution.set(executionKey, next)
    next.run.status = 'running'
    next.run.startedAt = now()
    syncRunRecord(next.run)
    emitRunMeta(next, 'running')
    log.info('session-run', `Run started ${next.run.id}`, {
      sessionId: next.run.sessionId,
      source: next.run.source,
      internal: next.run.internal,
      mode: next.run.mode,
      timeoutMs: next.maxRuntimeMs || null,
    })

    let runtimeTimer: ReturnType<typeof setTimeout> | null = null
    let finishedMissionId: string | null = null
    if (next.maxRuntimeMs && next.maxRuntimeMs > 0) {
      runtimeTimer = setTimeout(() => {
        next.signalController.abort()
      }, next.maxRuntimeMs)
    }

    try {
      const result = await executeExecutionChatTurn({
        sessionId: next.run.sessionId,
        message: next.message,
        imagePath: next.imagePath,
        imageUrl: next.imageUrl,
        attachedFiles: next.attachedFiles,
        internal: next.run.internal,
        source: next.run.source,
        runId: next.run.id,
        signal: next.signalController.signal,
        onEvent: (event) => emitToSubscribers(next, event),
        modelOverride: next.modelOverride,
        heartbeatConfig: next.heartbeatConfig,
        replyToId: next.replyToId,
      })

      const failed = !!result.error
      const aborted = next.signalController.signal.aborted
      next.run.status = aborted ? 'cancelled' : (failed ? 'failed' : 'completed')
      next.run.endedAt = next.run.endedAt || now()
      next.run.error = aborted ? (next.run.error || 'Cancelled') : result.error
      next.run.missionId = result.missionId || next.run.missionId || null
      finishedMissionId = next.run.missionId || null
      next.run.resultPreview = result.text?.slice(0, 280)
      if (typeof result.inputTokens === 'number') next.run.totalInputTokens = result.inputTokens
      if (typeof result.outputTokens === 'number') next.run.totalOutputTokens = result.outputTokens
      if (typeof result.estimatedCost === 'number') next.run.estimatedCost = result.estimatedCost
      syncRunRecord(next.run)
      emitRunMeta(next, next.run.status, {
        persisted: result.persisted,
        hasText: !!result.text,
        error: next.run.error || null,
      })
      log.info('session-run', `Run finished ${next.run.id}`, {
        sessionId: next.run.sessionId,
        status: next.run.status,
        persisted: result.persisted,
        hasText: !!result.text,
        error: next.run.error || null,
        durationMs: (next.run.endedAt || now()) - (next.run.startedAt || now()),
      })
      const followup = handleMainLoopRunResult({
        runId: next.run.id,
        sessionId: next.run.sessionId,
        message: next.message,
        internal: next.run.internal,
        source: next.run.source,
        resultText: result.text,
        error: next.run.error,
        toolEvents: result.toolEvents,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCost: result.estimatedCost,
      })
      queueAutonomyObservation({
        runId: next.run.id,
        sessionId: next.run.sessionId,
        source: next.run.source,
        status: next.run.status,
        resultText: result.text,
        error: next.run.error || null,
        toolEvents: result.toolEvents,
        sourceMessage: next.message,
      })
      if (followup) {
        setTimeout(() => {
          try {
            deps.enqueueSessionRun({
              sessionId: next.run.sessionId,
              message: followup.message,
              internal: true,
              source: 'main-loop-followup',
              mode: 'followup',
              dedupeKey: followup.dedupeKey,
            })
          } catch (err: unknown) {
            log.warn('session-run', `Main loop follow-up enqueue failed for ${next.run.sessionId}`, {
              error: errorMessage(err),
            })
          }
        }, Math.max(0, followup.delayMs || 0))
      }
      next.resolve(result)
    } catch (err: unknown) {
      const aborted = next.signalController.signal.aborted
      next.run.status = aborted ? 'cancelled' : 'failed'
      next.run.endedAt = now()
      next.run.error = errorMessage(err)
      finishedMissionId = next.run.missionId || null
      syncRunRecord(next.run)
      emitRunMeta(next, next.run.status, { error: next.run.error })
      log.error('session-run', `Run failed ${next.run.id}`, {
        sessionId: next.run.sessionId,
        status: next.run.status,
        error: next.run.error,
        durationMs: (next.run.endedAt || now()) - (next.run.startedAt || now()),
      })
      if (err instanceof Error && err.stack) {
        log.error('session-run', `Run failed stack trace ${next.run.id}`, {
          sessionId: next.run.sessionId,
          stack: err.stack,
        })
      }
      queueAutonomyObservation({
        runId: next.run.id,
        sessionId: next.run.sessionId,
        source: next.run.source,
        status: next.run.status,
        error: next.run.error || null,
        sourceMessage: next.message,
      })
      next.reject(err instanceof Error ? err : new Error(next.run.error))
    } finally {
      if (runtimeTimer) clearTimeout(runtimeTimer)
      state.runningByExecution.delete(executionKey)
      decrementNonHeartbeatWork(next)
      reconcileSessionActivityLease(next.run.sessionId)
      notify(`stream-end:${next.run.sessionId}`)
      if (finishedMissionId && next.run.source !== 'chat') {
        const missionId = finishedMissionId
        queueMicrotask(() => {
          import('@/lib/server/missions/mission-service')
            .then(({ loadMissionById, requestMissionTick }) => {
              const mission = loadMissionById(missionId)
              if (!mission) return
              if (mission.status !== 'active') return
              if (mission.phase === 'dispatching' || mission.phase === 'executing') return
              requestMissionTick(missionId, 'run_drained', {
                runId: next.run.id,
                source: next.run.source,
                status: next.run.status,
              })
            })
            .catch((err: unknown) => {
              log.warn('session-run', 'Mission tick failed', { missionId, runId: next.run.id, error: errorMessage(err) })
            })
        })
      }
      void drainExecution(executionKey, deps)
    }
  } finally {
    const currentDepth = state.drainDepth.get(executionKey)
    if (currentDepth && currentDepth > 1) state.drainDepth.set(executionKey, currentDepth - 1)
    else state.drainDepth.delete(executionKey)
  }
}
