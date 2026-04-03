import type { ExecuteChatTurnInput, ExecuteChatTurnResult } from './chat-execution-types'
import { perf } from '@/lib/server/runtime/perf'
import { markProviderSuccess } from '@/lib/server/provider-health'
import { executePreparedChatTurn } from '@/lib/server/chat-execution/chat-turn-stream-execution'
import { finalizeChatTurn } from '@/lib/server/chat-execution/chat-turn-finalization'
import { prepareChatTurn } from '@/lib/server/chat-execution/chat-turn-preparation'
import {
  createPartialAssistantPersistence,
} from '@/lib/server/chat-execution/chat-turn-partial-persistence'
import {
  completeBlockedChatTurn,
  runChatTurnPreflight,
} from '@/lib/server/chat-execution/chat-turn-preflight'

export {
  shouldApplySessionFreshnessReset,
  shouldAutoRouteHeartbeatAlerts,
  translateRequestedToolInvocation,
  normalizeAssistantArtifactLinks,
  requestedToolNamesFromMessage,
  filterRuntimeCapabilityIds,
  hasDirectLocalCodingTools,
} from '@/lib/server/chat-execution/chat-execution-utils'

export {
  reconcileConnectorDeliveryText,
} from '@/lib/server/chat-execution/chat-execution-connector-delivery'

export {
  buildAgentRuntimeCapabilities,
  buildEnabledToolsAutonomyGuidance,
  buildNoToolsGuidance,
} from '@/lib/server/chat-execution/chat-turn-preparation'

export {
  collectToolEvent,
  dedupeConsecutiveToolEvents,
  deriveTerminalRunError,
  isLikelyToolErrorOutput,
} from '@/lib/server/chat-execution/chat-execution-tool-events'
export {
  pruneSuppressedHeartbeatStreamMessage,
  shouldAppendMissedRequestedToolNotice,
} from '@/lib/server/chat-execution/chat-turn-finalization'

export type { ExecuteChatTurnInput, ExecuteChatTurnResult } from './chat-execution-types'

export async function executeSessionChatTurn(input: ExecuteChatTurnInput): Promise<ExecuteChatTurnResult> {
  const {
    sessionId,
    source = 'chat',
  } = input
  const endTurnPerf = perf.start('chat-execution', 'executeSessionChatTurn', { sessionId, source })
  const preparedTurn = await prepareChatTurn(input)
  if (preparedTurn.kind === 'blocked') {
    const result = await completeBlockedChatTurn(preparedTurn)
    endTurnPerf({
      durationMs: 0,
      toolEventCount: result.toolEvents.length,
      inputTokens: result.inputTokens || 0,
      outputTokens: result.outputTokens || 0,
      error: !!result.error,
    })
    return result
  }

  const partialPersistence = createPartialAssistantPersistence({
    prepared: preparedTurn,
    onEvent: input.onEvent,
  })

  const preflight = await runChatTurnPreflight({
    prepared: preparedTurn,
    emit: partialPersistence.emit,
    toolEvents: partialPersistence.getToolEvents(),
  })

  if (preflight?.terminalResult) {
    if (preflight.terminalResult.text) input.onEvent?.({ t: 'd', text: preflight.terminalResult.text })
    partialPersistence.stop()
    await partialPersistence.awaitIdle()
    endTurnPerf({
      durationMs: 0,
      toolEventCount: preflight.terminalResult.toolEvents.length,
      inputTokens: preflight.terminalResult.inputTokens || 0,
      outputTokens: preflight.terminalResult.outputTokens || 0,
      error: !!preflight.terminalResult.error,
    })
    return preflight.terminalResult
  }

  const streamResult = await executePreparedChatTurn({
    input,
    prepared: preparedTurn,
    partialPersistence,
    preflightToolRoutingResult: preflight?.directMemoryResult || null,
  })

  await partialPersistence.awaitIdle()

  if (!streamResult.errorMessage) {
    markProviderSuccess(preparedTurn.providerType, preparedTurn.sessionForRun.credentialId)
  }

  const result = await finalizeChatTurn({
    input,
    prepared: preparedTurn,
    partialPersistence,
    fullResponse: streamResult.fullResponse,
    errorMessage: streamResult.errorMessage,
    initialToolRoutingResult: streamResult.toolRoutingResult,
    responseCacheHit: streamResult.responseCacheHit,
    directUsage: streamResult.directUsage,
    durationMs: streamResult.durationMs,
    knowledgeRetrievalTrace: streamResult.knowledgeRetrievalTrace || null,
    emit: partialPersistence.emit,
  })

  endTurnPerf({
    durationMs: streamResult.durationMs,
    toolEventCount: result.toolEvents.length,
    inputTokens: result.inputTokens || 0,
    outputTokens: result.outputTokens || 0,
    error: !!result.error,
  })

  return result
}
