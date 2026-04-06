import type { ExecuteChatTurnInput, ExecuteChatTurnResult } from './chat-execution-types'
import { perf } from '@/lib/server/runtime/perf'
import { setSpanAttributes, withServerSpan } from '@/lib/server/observability/otel-tracing'
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
  return withServerSpan('swarmclaw.chat.turn', {
    'swarmclaw.session.id': sessionId,
    'swarmclaw.chat.source': source,
    'swarmclaw.chat.has_image': Boolean(input.imagePath || input.imageUrl),
    'swarmclaw.chat.attached_file_count': input.attachedFiles?.length || 0,
  }, async (span) => {
    const endTurnPerf = perf.start('chat-execution', 'executeSessionChatTurn', { sessionId, source })
    const preparedTurn = await prepareChatTurn(input)
    if (preparedTurn.kind === 'blocked') {
      const result = await completeBlockedChatTurn(preparedTurn)
      setSpanAttributes(span, {
        'swarmclaw.chat.blocked': true,
        'swarmclaw.chat.tool_event_count': result.toolEvents.length,
        'swarmclaw.chat.error': Boolean(result.error),
        'gen_ai.usage.input_tokens': result.inputTokens || 0,
        'gen_ai.usage.output_tokens': result.outputTokens || 0,
      })
      endTurnPerf({
        durationMs: 0,
        toolEventCount: result.toolEvents.length,
        inputTokens: result.inputTokens || 0,
        outputTokens: result.outputTokens || 0,
        error: !!result.error,
      })
      return result
    }

    setSpanAttributes(span, {
      'swarmclaw.chat.blocked': false,
      'swarmclaw.chat.agentic': preparedTurn.hasExtensions,
      'swarmclaw.chat.provider': preparedTurn.providerType,
      'gen_ai.request.model': preparedTurn.sessionForRun.model,
    })

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
      setSpanAttributes(span, {
        'swarmclaw.chat.preflight_terminal': true,
        'swarmclaw.chat.tool_event_count': preflight.terminalResult.toolEvents.length,
        'swarmclaw.chat.error': Boolean(preflight.terminalResult.error),
        'gen_ai.usage.input_tokens': preflight.terminalResult.inputTokens || 0,
        'gen_ai.usage.output_tokens': preflight.terminalResult.outputTokens || 0,
      })
      endTurnPerf({
        durationMs: 0,
        toolEventCount: preflight.terminalResult.toolEvents.length,
        inputTokens: preflight.terminalResult.inputTokens || 0,
        outputTokens: preflight.terminalResult.outputTokens || 0,
        error: !!preflight.terminalResult.error,
      })
      return preflight.terminalResult
    }

    let streamResult: Awaited<ReturnType<typeof executePreparedChatTurn>>
    try {
      streamResult = await executePreparedChatTurn({
        input,
        prepared: preparedTurn,
        partialPersistence,
        preflightToolRoutingResult: preflight?.directMemoryResult || null,
      })

      await partialPersistence.awaitIdle()
    } finally {
      partialPersistence.stop()
    }

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

    setSpanAttributes(span, {
      'swarmclaw.chat.cache_hit': streamResult.responseCacheHit,
      'swarmclaw.chat.tool_event_count': result.toolEvents.length,
      'swarmclaw.chat.error': Boolean(result.error),
      'swarmclaw.chat.estimated_cost': result.estimatedCost ?? 0,
      'swarmclaw.chat.has_retrieval_trace': Boolean(result.retrievalTrace),
      'gen_ai.usage.input_tokens': result.inputTokens || 0,
      'gen_ai.usage.output_tokens': result.outputTokens || 0,
    })
    endTurnPerf({
      durationMs: streamResult.durationMs,
      toolEventCount: result.toolEvents.length,
      inputTokens: result.inputTokens || 0,
      outputTokens: result.outputTokens || 0,
      error: !!result.error,
    })

    return result
  })
}
