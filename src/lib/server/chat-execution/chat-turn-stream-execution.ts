import { CONTEXT_OVERFLOW_RE } from '@/lib/providers/error-classification'
import type { KnowledgeRetrievalTrace, ProviderType } from '@/types'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { isLocalOpenClawEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { applyContextClearBoundary } from '@/lib/server/chat-execution/chat-execution-utils'
import { estimateCost } from '@/lib/server/cost'
import { log } from '@/lib/server/logger'
import { runCapabilityHook } from '@/lib/server/native-capabilities'
import { markProviderFailure } from '@/lib/server/provider-health'
import {
  getCachedLlmResponse,
  resolveLlmResponseCacheConfig,
  setCachedLlmResponse,
  type LlmResponseCacheKeyInput,
} from '@/lib/server/llm-response-cache'
import {
  activeSessionProcesses,
  clearActiveSessionProcess,
  registerActiveSessionProcess,
} from '@/lib/server/runtime/runtime-state'
import { perf } from '@/lib/server/runtime/perf'
import { getSessionMessages } from '@/lib/server/sessions/session-repository'
import { notify } from '@/lib/server/ws-hub'
import { setSpanAttributes, withServerSpan } from '@/lib/server/observability/otel-tracing'
import { errorMessage as toErrorMessage } from '@/lib/shared-utils'

import type { ExecuteChatTurnInput } from './chat-execution-types'
import type { PartialAssistantPersistence } from '@/lib/server/chat-execution/chat-turn-partial-persistence'
import type { PreparedExecutableChatTurn } from '@/lib/server/chat-execution/chat-turn-preparation'
import type { ToolRoutingResult } from '@/lib/server/chat-execution/chat-turn-tool-routing'

const TAG = 'chat-execution'

export interface ExecutedPreparedChatTurn {
  fullResponse: string
  errorMessage?: string
  toolRoutingResult: ToolRoutingResult | null
  responseCacheHit: boolean
  durationMs: number
  directUsage: {
    inputTokens: number
    outputTokens: number
    received: boolean
  }
  knowledgeRetrievalTrace?: KnowledgeRetrievalTrace | null
}

export async function executePreparedChatTurn(params: {
  input: ExecuteChatTurnInput
  prepared: PreparedExecutableChatTurn
  partialPersistence: PartialAssistantPersistence
  preflightToolRoutingResult?: ToolRoutingResult | null
}): Promise<ExecutedPreparedChatTurn> {
  const { input, prepared, partialPersistence, preflightToolRoutingResult = null } = params
  const {
    sessionId,
    imageUrl,
    attachedFiles,
    internal = false,
    runId,
    source = 'chat',
    signal,
  } = input
  const {
    sessionForRun,
    appSettings,
    lifecycleRunId,
    extensionsForRun,
    effectiveMessage,
    providerType,
    provider,
    apiKey,
    hasExtensions,
    systemPrompt,
    resolvedImagePath,
    heartbeatLightContext,
    isAutoRunNoHistory,
    executionBrief,
    executionBriefContextBlock,
    classification,
    promptMode,
  } = prepared

  const emit = partialPersistence.emit
  const parseAndEmit = partialPersistence.parseAndEmit
  let fullResponse = ''
  let errorMessage: string | undefined

  const directUsage = { inputTokens: 0, outputTokens: 0, received: false }
  const responseCacheConfig = resolveLlmResponseCacheConfig(appSettings)
  let responseCacheHit = false
  let responseCacheInput: LlmResponseCacheKeyInput | null = null
  let durationMs = 0
  let knowledgeRetrievalTrace: KnowledgeRetrievalTrace | null = null
  const startTs = Date.now()
  const endLlmPerf = perf.start('chat-execution', 'llm-round-trip', {
    sessionId,
    provider: providerType,
    hasExtensions,
    extensionCount: getEnabledCapabilityIds(sessionForRun).length,
  })

  if (preflightToolRoutingResult) {
    fullResponse = preflightToolRoutingResult.fullResponse
    errorMessage = preflightToolRoutingResult.errorMessage
    if (fullResponse) emit({ t: 'd', text: fullResponse })
    partialPersistence.stop()
    endLlmPerf({ durationMs: 0, cacheHit: false })
    return {
      fullResponse,
      errorMessage,
      toolRoutingResult: preflightToolRoutingResult,
      responseCacheHit,
      durationMs,
      directUsage,
      knowledgeRetrievalTrace: null,
    }
  }

  const abortController = new AbortController()
  const abortFromOutside = () => abortController.abort()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', abortFromOutside)
  }

  registerActiveSessionProcess(sessionId, {
    runId: runId || null,
    source,
    kill: () => abortController.abort(),
  })

  try {
    const heartbeatHistory = isAutoRunNoHistory
      ? (heartbeatLightContext ? [] : getSessionMessages(sessionId).slice(-6))
      : undefined

    const useLocalOpenClawNativeRuntime = providerType === 'openclaw' && isLocalOpenClawEndpoint(sessionForRun.apiEndpoint)
    log.info(
      TAG,
      `provider=${providerType}, hasExtensions=${hasExtensions}, localOpenClawNative=${useLocalOpenClawNativeRuntime}, imagePath=${resolvedImagePath || 'none'}, attachedFiles=${attachedFiles?.length || 0}, extensions=${getEnabledCapabilityIds(sessionForRun).length}`,
    )

    if (hasExtensions) {
      const result = await withServerSpan('swarmclaw.chat.agentic_stream', {
        'swarmclaw.session.id': sessionId,
        'swarmclaw.chat.source': source,
        'swarmclaw.chat.provider': providerType,
        'gen_ai.request.model': sessionForRun.model,
      }, async (span) => {
        const agenticResult = await streamAgentChat({
          session: sessionForRun,
          message: effectiveMessage,
          imagePath: resolvedImagePath,
          imageUrl,
          attachedFiles,
          apiKey,
          systemPrompt,
          executionBrief,
          extraSystemContext: [executionBriefContextBlock].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
          write: (raw) => parseAndEmit(raw),
          history: heartbeatHistory ?? applyContextClearBoundary(getSessionMessages(sessionId)),
          signal: abortController.signal,
          source,
          classification,
          promptMode,
        })
        setSpanAttributes(span, {
          'swarmclaw.chat.tool_event_count': agenticResult.toolEvents.length,
          'swarmclaw.chat.has_retrieval_trace': Boolean(agenticResult.knowledgeRetrievalTrace),
        })
        return agenticResult
      })
      fullResponse = result.finalResponse || result.fullText
      knowledgeRetrievalTrace = result.knowledgeRetrievalTrace || null
    } else {
      let directHistorySnapshot = isAutoRunNoHistory
        ? (heartbeatLightContext ? [] : getSessionMessages(sessionId).slice(-6))
        : applyContextClearBoundary(getSessionMessages(sessionId))
      responseCacheInput = {
        provider: providerType,
        model: sessionForRun.model,
        apiEndpoint: sessionForRun.apiEndpoint || '',
        systemPrompt,
        message: effectiveMessage,
        imagePath: input.imagePath,
        imageUrl,
        attachedFiles,
        history: directHistorySnapshot,
      }
      const canUseResponseCache = !internal && responseCacheConfig.enabled
      const cached = canUseResponseCache
        ? getCachedLlmResponse(responseCacheInput, responseCacheConfig)
        : null
      if (cached) {
        responseCacheHit = true
        fullResponse = cached.text
        emit({
          t: 'md',
          text: JSON.stringify({
            cache: {
              hit: true,
              ageMs: cached.ageMs,
              provider: cached.provider,
              model: cached.model,
            },
          }),
        })
        emit({ t: 'd', text: cached.text })
      } else {
        await runCapabilityHook(
          'llmInput',
          {
            session: sessionForRun,
            runId: lifecycleRunId,
            provider: providerType as ProviderType,
            model: sessionForRun.model,
            systemPrompt,
            prompt: effectiveMessage,
            historyMessages: directHistorySnapshot,
            imagesCount: resolvedImagePath ? 1 : 0,
          },
          { enabledIds: extensionsForRun },
        )
        const doStreamChat = () => provider.handler.streamChat({
          session: sessionForRun,
          message: effectiveMessage,
          imagePath: resolvedImagePath,
          apiKey,
          systemPrompt,
          write: (raw: string) => parseAndEmit(raw),
          active: activeSessionProcesses,
          loadHistory: (sid: string) => {
            if (sid === sessionId) return directHistorySnapshot
            return isAutoRunNoHistory
              ? getSessionMessages(sid).slice(-6)
              : applyContextClearBoundary(getSessionMessages(sid))
          },
          onUsage: (usage) => {
            directUsage.inputTokens = usage.inputTokens
            directUsage.outputTokens = usage.outputTokens
            directUsage.received = true
          },
          signal: abortController.signal,
        })
        try {
          fullResponse = await withServerSpan('swarmclaw.chat.model_stream', {
            'swarmclaw.session.id': sessionId,
            'swarmclaw.chat.source': source,
            'swarmclaw.chat.provider': providerType,
            'gen_ai.request.model': sessionForRun.model,
          }, async (span) => {
            const response = await doStreamChat()
            setSpanAttributes(span, {
              'gen_ai.usage.input_tokens': directUsage.inputTokens || 0,
              'gen_ai.usage.output_tokens': directUsage.outputTokens || 0,
              'swarmclaw.chat.response_cacheable': canUseResponseCache,
            })
            return response
          })
        } catch (streamErr: unknown) {
          const streamErrMsg = toErrorMessage(streamErr)
          const streamStatus = (streamErr as Record<string, unknown>)?.status
          if (typeof streamStatus === 'number' && streamStatus === 400 && CONTEXT_OVERFLOW_RE.test(streamErrMsg)) {
            log.warn('chat-run', 'Context overflow in direct path, reducing history and retrying', {
              sessionId,
              error: streamErrMsg,
              historyLen: directHistorySnapshot.length,
            })
            directHistorySnapshot = directHistorySnapshot.slice(-10)
            fullResponse = await withServerSpan('swarmclaw.chat.model_stream.retry', {
              'swarmclaw.session.id': sessionId,
              'swarmclaw.chat.source': source,
              'swarmclaw.chat.provider': providerType,
              'gen_ai.request.model': sessionForRun.model,
              'swarmclaw.chat.retry_reason': 'context_overflow',
            }, async (span) => {
              const response = await doStreamChat()
              setSpanAttributes(span, {
                'gen_ai.usage.input_tokens': directUsage.inputTokens || 0,
                'gen_ai.usage.output_tokens': directUsage.outputTokens || 0,
              })
              return response
            })
          } else {
            throw streamErr
          }
        }
        await runCapabilityHook(
          'llmOutput',
          {
            session: sessionForRun,
            runId: lifecycleRunId,
            provider: providerType as ProviderType,
            model: sessionForRun.model,
            assistantTexts: fullResponse ? [fullResponse] : [],
            response: fullResponse,
            usage: directUsage.received
              ? {
                  input: directUsage.inputTokens,
                  output: directUsage.outputTokens,
                  total: directUsage.inputTokens + directUsage.outputTokens,
                  estimatedCost: estimateCost(sessionForRun.model, directUsage.inputTokens, directUsage.outputTokens),
                }
              : undefined,
          },
          { enabledIds: extensionsForRun },
        )
        if (canUseResponseCache && responseCacheInput && fullResponse) {
          setCachedLlmResponse(responseCacheInput, fullResponse, responseCacheConfig)
        }
      }
    }
    durationMs = Date.now() - startTs
    endLlmPerf({ durationMs, cacheHit: responseCacheHit })
  } catch (err: unknown) {
    endLlmPerf({ error: true })
    errorMessage = toErrorMessage(err)
    const failureText = errorMessage || 'Run failed.'
    markProviderFailure(providerType, failureText, sessionForRun.credentialId)
    emit({ t: 'err', text: failureText })
    log.error('chat-run', `Run failed for session ${sessionId}`, {
      runId,
      source,
      internal,
      error: failureText,
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join('\n') : undefined,
    })
  } finally {
    partialPersistence.stop()
    clearActiveSessionProcess(sessionId)
    notify('sessions')
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  return {
    fullResponse,
    errorMessage,
    toolRoutingResult: null,
    responseCacheHit,
    durationMs,
    directUsage,
    knowledgeRetrievalTrace,
  }
}
