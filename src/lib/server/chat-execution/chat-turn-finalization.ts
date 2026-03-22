import type { Message, MessageToolEvent, SSEEvent, Session, UsageRecord } from '@/types'
import { applyExactOutputContract, classifyExactOutputContract, type ExactOutputContract } from '@/lib/server/chat-execution/exact-output-contract'
import { stripMainLoopMetaForPersistence } from '@/lib/server/agents/main-agent-loop'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import { pruneStreamingAssistantArtifacts } from '@/lib/chat/chat-streaming-state'
import { pruneIncompleteToolEvents } from '@/lib/server/chat-execution/chat-streaming-utils'
import { reconcileConnectorDeliveryText } from '@/lib/server/chat-execution/chat-execution-connector-delivery'
import {
  classifyHeartbeatResponse,
  estimateConversationTone,
  extractHeartbeatStatus,
  getPersistedAssistantText,
  hasPersistableAssistantPayload,
  normalizeAssistantArtifactLinks,
  pruneOldHeartbeatMessages,
  shouldAutoRouteHeartbeatAlerts,
  shouldReplaceRecentAssistantMessage,
  shouldReplaceRecentConnectorFollowupMessage,
  shouldSuppressRedundantConnectorDeliveryFollowup,
} from '@/lib/server/chat-execution/chat-execution-utils'
import {
  dedupeConsecutiveToolEvents,
  deriveTerminalRunError,
} from '@/lib/server/chat-execution/chat-execution-tool-events'
import { estimateCost } from '@/lib/server/cost'
import { refreshSessionIdentityState } from '@/lib/server/identity-continuity'
import { log } from '@/lib/server/logger'
import { syncSessionArchiveMemory } from '@/lib/server/memory/session-archive-memory'
import {
  applyMissionOutcomeForTurn,
} from '@/lib/server/missions/mission-service'
import { runCapabilityHook, transformCapabilityText } from '@/lib/server/native-capabilities'
import { isHeartbeatSource } from '@/lib/server/runtime/heartbeat-source'
import { perf } from '@/lib/server/runtime/perf'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import { getSession, saveSession } from '@/lib/server/sessions/session-repository'
import {
  getMessages,
  getMessageCount,
  appendMessage,
  replaceMessageAt,
  replaceAllMessages,
} from '@/lib/server/messages/message-repository'
import { appendUsage } from '@/lib/server/usage/usage-repository'
import { synchronizeWorkingStateForTurn } from '@/lib/server/working-state/service'
import { notify } from '@/lib/server/ws-hub'

import type { ExecuteChatTurnInput, ExecuteChatTurnResult } from './chat-execution-types'
import type { PartialAssistantPersistence } from '@/lib/server/chat-execution/chat-turn-partial-persistence'
import {
  applyMessageLifecycleHooks,
  type PreparedExecutableChatTurn,
} from '@/lib/server/chat-execution/chat-turn-preparation'
import {
  runPostLlmToolRouting,
  type ToolRoutingResult,
} from '@/lib/server/chat-execution/chat-turn-tool-routing'

const EXACT_OUTPUT_CONTRACT_TIMEOUT_MS = 5_000

function resolveHeartbeatLastConnectorTarget(session: Session | null | undefined): {
  connectorId?: string
  channelId: string
} | null {
  if (!isDirectConnectorSession(session)) return null
  const connectorId = typeof session?.connectorContext?.connectorId === 'string'
    ? session.connectorContext.connectorId.trim()
    : ''
  const channelId = typeof session?.connectorContext?.channelId === 'string'
    ? session.connectorContext.channelId.trim()
    : ''
  if (!channelId) return null
  return {
    connectorId: connectorId || undefined,
    channelId,
  }
}

function shouldAutoDraftSkillSuggestion(params: {
  assistantPersisted: boolean
  internal: boolean
  isHeartbeatRun: boolean
  agentAutoDraftSetting: boolean
  toolEventCount: number
  messageCount: number
}): boolean {
  if (!params.assistantPersisted) return false
  if (params.internal || params.isHeartbeatRun) return false
  if (!params.agentAutoDraftSetting) return false
  if (params.toolEventCount === 0) return false
  return params.messageCount >= 4
}

async function resolveExactOutputContractWithTimeout(params: {
  sessionId: string
  agentId?: string | null
  userMessage: string
  currentResponse: string
  toolEvents: MessageToolEvent[]
  internal: boolean
  source: string
}): Promise<ExactOutputContract | null> {
  if (params.internal || params.source !== 'chat') return null
  if (params.toolEvents.length === 0) return null
  const { extractExplicitExactLiteral } = await import('@/lib/server/chat-execution/exact-output-contract')
  if (!extractExplicitExactLiteral(params.userMessage)) return null

  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race<ExactOutputContract | null>([
      classifyExactOutputContract({
        sessionId: params.sessionId,
        agentId: params.agentId || null,
        userMessage: params.userMessage,
        currentResponse: params.currentResponse,
        toolEvents: params.toolEvents,
      }).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EXACT_OUTPUT_CONTRACT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function shouldAppendMissedRequestedToolNotice(params: {
  missedRequestedTools: string[]
  fullResponse: string
  errorMessage?: string
  calledToolCount?: number
}): boolean {
  if (!Array.isArray(params.missedRequestedTools) || params.missedRequestedTools.length === 0) return false
  if (params.errorMessage) return false
  if (params.fullResponse.includes('Tool execution notice:')) return false
  if (!params.fullResponse.trim() && (params.calledToolCount || 0) === 0) return false
  return true
}

export function pruneSuppressedHeartbeatStreamMessage(messages: Message[]): boolean {
  return pruneStreamingAssistantArtifacts(messages)
}

export async function finalizeChatTurn(params: {
  input: ExecuteChatTurnInput
  prepared: PreparedExecutableChatTurn
  partialPersistence: PartialAssistantPersistence
  fullResponse: string
  errorMessage?: string
  initialToolRoutingResult?: ToolRoutingResult | null
  responseCacheHit: boolean
  directUsage: {
    inputTokens: number
    outputTokens: number
    received: boolean
  }
  durationMs: number
  emit: (event: SSEEvent) => void
}): Promise<ExecuteChatTurnResult> {
  const {
    input,
    prepared,
    partialPersistence,
    initialToolRoutingResult = null,
    responseCacheHit,
    directUsage,
    durationMs,
    emit,
  } = params
  let { fullResponse, errorMessage } = params
  const { message } = input
  const {
    sessionId,
    internal = false,
    runId,
    source = 'chat',
  } = input
  const {
    session,
    sessionForRun,
    appSettings,
    lifecycleRunId,
    mission,
    extensionsForRun,
    effectiveMessage,
    providerType,
    hideAssistantTranscript,
    isHeartbeatRun,
    hasExtensions,
    runStartedAt,
    runMessageStartIndex,
    toolPolicy,
  } = prepared

  const endPostProcessPerf = perf.start('chat-execution', 'post-process', { sessionId })

  if (!hasExtensions && fullResponse && !errorMessage && !responseCacheHit) {
    const inputTokens = directUsage.received ? directUsage.inputTokens : Math.ceil(message.length / 4)
    const outputTokens = directUsage.received ? directUsage.outputTokens : Math.ceil(fullResponse.length / 4)
    const totalTokens = inputTokens + outputTokens
    if (totalTokens > 0) {
      const cost = estimateCost(sessionForRun.model, inputTokens, outputTokens)
      const history = getMessages(sessionId)
      const usageRecord: UsageRecord = {
        sessionId,
        messageIndex: history.length,
        model: sessionForRun.model,
        provider: providerType,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost: cost,
        timestamp: Date.now(),
        durationMs,
        agentId: sessionForRun.agentId || null,
        projectId: sessionForRun.projectId || null,
      }
      appendUsage(sessionId, usageRecord)
      emit({
        t: 'md',
        text: JSON.stringify({ usage: { inputTokens, outputTokens, totalTokens, estimatedCost: cost } }),
      })
    }
  }

  const toolEvents = partialPersistence.getToolEvents()
  const toolRoutingResult = initialToolRoutingResult || await runPostLlmToolRouting({
    session: sessionForRun,
    sessionId,
    message,
    effectiveMessage,
    enabledExtensions: extensionsForRun,
    toolPolicy,
    appSettings,
    internal,
    source,
    toolEvents,
    emit,
  }, fullResponse, errorMessage)

  fullResponse = toolRoutingResult.fullResponse
  errorMessage = toolRoutingResult.errorMessage

  const {
    thinkingText,
    streamErrors,
    accumulatedUsage,
  } = partialPersistence.getSnapshot()

  if (shouldAppendMissedRequestedToolNotice({
    missedRequestedTools: toolRoutingResult.missedRequestedTools,
    fullResponse,
    errorMessage,
    calledToolCount: toolRoutingResult.calledNames.size,
  })) {
    const notice = `Tool execution notice: requested tool(s) ${toolRoutingResult.missedRequestedTools.join(', ')} were not actually invoked in this run.`
    emit({ t: 'err', text: notice })
    const trimmedResponse = (fullResponse || '').trim()
    fullResponse = trimmedResponse
      ? `${trimmedResponse}\n\n${notice}`
      : notice
  }

  const terminalError = deriveTerminalRunError({
    errorMessage,
    fullResponse: fullResponse || '',
    streamErrors,
    toolEvents,
    internal,
  })
  if (terminalError && terminalError !== errorMessage) {
    if (!errorMessage) {
      log.warn('chat-run', `Run ended without a visible response for session ${sessionId}`, {
        runId,
        source,
        internal,
        provider: providerType,
        messagePreview: effectiveMessage.slice(0, 200),
        inferredError: terminalError,
      })
    }
    errorMessage = terminalError
  }

  const persistedToolEvents = dedupeConsecutiveToolEvents(pruneIncompleteToolEvents(toolEvents))
  let finalText = (fullResponse || '').trim() || (!internal && errorMessage ? `Error: ${errorMessage}` : '')
  if (extensionsForRun.length > 0 && finalText && !isHeartbeatRun) {
    try {
      finalText = await transformCapabilityText(
        'transformOutboundMessage',
        { session: sessionForRun, text: finalText },
        { enabledIds: extensionsForRun },
      )
    } catch {
      // Outbound transforms are non-critical.
    }
  }
  finalText = reconcileConnectorDeliveryText(finalText, persistedToolEvents)
  finalText = normalizeAssistantArtifactLinks(finalText, session.cwd)
  finalText = applyExactOutputContract({
    contract: await resolveExactOutputContractWithTimeout({
      sessionId,
      agentId: sessionForRun.agentId || null,
      userMessage: message,
      currentResponse: finalText,
      toolEvents: persistedToolEvents,
      internal,
      source,
    }),
    text: finalText,
    errorMessage,
    toolEvents: persistedToolEvents,
  })
  const rawTextForPersistence = stripMainLoopMetaForPersistence(finalText)
  const hiddenControlOnly = shouldSuppressHiddenControlText(rawTextForPersistence)
  const textForPersistence = stripHiddenControlTokens(rawTextForPersistence)
  const persistedText = getPersistedAssistantText(textForPersistence, persistedToolEvents)
  let persistedResponseForHooks = textForPersistence

  if (isHeartbeatRun && rawTextForPersistence) {
    const heartbeatStatus = extractHeartbeatStatus(rawTextForPersistence)
    if (heartbeatStatus) emit({ t: 'status', text: JSON.stringify(heartbeatStatus) })
  }

  const heartbeatConfig = input.heartbeatConfig
  let heartbeatClassification: 'suppress' | 'strip' | 'keep' | null = null
  if (isHeartbeatRun && rawTextForPersistence.length > 0) {
    heartbeatClassification = classifyHeartbeatResponse(
      rawTextForPersistence,
      heartbeatConfig?.ackMaxChars ?? 300,
      toolEvents.length > 0,
    )
    if (heartbeatClassification !== 'suppress' && !toolEvents.length) {
      const prevText = session.lastHeartbeatText || ''
      const prevSentAt = session.lastHeartbeatSentAt || 0
      const isDuplicate = prevText.trim() === persistedText.trim()
        && (Date.now() - prevSentAt) < 24 * 60 * 60 * 1000
      if (isDuplicate) {
        heartbeatClassification = 'suppress'
        log.info('heartbeat', `Duplicate heartbeat suppressed for session ${sessionId} (same text within 24h)`)
      }
    }
  }

  if (isHeartbeatRun && session.agentId) {
    notify(`heartbeat:agent:${session.agentId}`)
  }

  const shouldPersistAssistant = !hiddenControlOnly
    && !hideAssistantTranscript
    && hasPersistableAssistantPayload(persistedText, thinkingText, persistedToolEvents)
    && heartbeatClassification !== 'suppress'
    && !(isHeartbeatRun && (
      heartbeatConfig?.deliveryMode === 'silent'
      || (heartbeatConfig?.deliveryMode === 'tool_only' && !isDirectConnectorSession(session))
    ))

  const normalizeResumeId = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null

  const current = getSession(sessionId)
  let assistantPersisted = false
  if (current) {
    // Load messages from relational table (lazy-migrates from blob on first access)
    const messages = getMessages(sessionId)
    let messagesPruned = false
    if (!isDirectConnectorSession(current) && current.connectorContext) {
      current.connectorContext = undefined
    }
    const currentAgent = current.agentId ? getAgent(current.agentId) : null
    if (pruneStreamingAssistantArtifacts(messages, {
      minIndex: runMessageStartIndex,
      minTime: runStartedAt,
    })) messagesPruned = true
    const persistField = (key: string, value: unknown) => {
      const normalized = normalizeResumeId(value)
      if ((current as unknown as Record<string, unknown>)[key] !== normalized) {
        ;(current as unknown as Record<string, unknown>)[key] = normalized
      }
    }

    persistField('claudeSessionId', session.claudeSessionId)
    persistField('codexThreadId', session.codexThreadId)
    persistField('opencodeSessionId', session.opencodeSessionId)

    const sourceResume = session.delegateResumeIds
    if (sourceResume && typeof sourceResume === 'object') {
      const currentResume = (current.delegateResumeIds && typeof current.delegateResumeIds === 'object')
        ? current.delegateResumeIds
        : {}
      const sr = sourceResume as Record<string, unknown>
      const cr = currentResume as Record<string, unknown>
      const nextResume = {
        claudeCode: normalizeResumeId(sr.claudeCode ?? cr.claudeCode),
        codex: normalizeResumeId(sr.codex ?? cr.codex),
        opencode: normalizeResumeId(sr.opencode ?? cr.opencode),
        gemini: normalizeResumeId(sr.gemini ?? cr.gemini),
      }
      if (JSON.stringify(currentResume) !== JSON.stringify(nextResume)) {
        current.delegateResumeIds = nextResume
      }
    }

    let persistedAssistantMsg: Message | null = null
    let replacedLast = false
    if (shouldPersistAssistant) {
      const persistedKind = isHeartbeatRun ? 'heartbeat' : 'chat'
      const nowTs = Date.now()
      const nextAssistantMessage = await applyMessageLifecycleHooks({
        session: current,
        message: {
          role: 'assistant',
          text: persistedText,
          time: nowTs,
          thinking: thinkingText || undefined,
          toolEvents: persistedToolEvents.length ? persistedToolEvents : undefined,
          kind: persistedKind,
        },
        enabledIds: extensionsForRun,
        phase: isHeartbeatRun ? 'heartbeat' : 'assistant_final',
        runId: lifecycleRunId,
      })
      if (nextAssistantMessage) {
        const previous = messages.at(-1)
        const nextToolEvents = nextAssistantMessage.toolEvents || []
        const nextKind = nextAssistantMessage.kind || persistedKind
        if (shouldSuppressRedundantConnectorDeliveryFollowup({
          previous,
          nextText: nextAssistantMessage.text,
          nextToolEvents,
          nextKind,
          now: nowTs,
        })) {
          persistedResponseForHooks = nextAssistantMessage.text
        } else if (previous?.runId === lifecycleRunId || shouldReplaceRecentAssistantMessage({
          previous,
          nextToolEvents,
          nextKind,
          now: nowTs,
        }) || shouldReplaceRecentConnectorFollowupMessage({
          previous,
          nextText: nextAssistantMessage.text,
          nextToolEvents,
          nextKind,
          now: nowTs,
        })) {
          messages[messages.length - 1] = nextAssistantMessage
          assistantPersisted = true
          replacedLast = true
          persistedAssistantMsg = nextAssistantMessage
        } else {
          messages.push(nextAssistantMessage)
          assistantPersisted = true
          persistedAssistantMsg = nextAssistantMessage
        }
        persistedResponseForHooks = nextAssistantMessage.text
        if (assistantPersisted) {
          if (isHeartbeatRun) {
            current.lastHeartbeatText = nextAssistantMessage.text
            current.lastHeartbeatSentAt = nowTs
          }
          try {
            await runCapabilityHook('onMessage', { session: current, message: nextAssistantMessage }, { enabledIds: extensionsForRun })
          } catch {
            // onMessage hooks are non-critical.
          }

          if (!internal) {
            const tone = estimateConversationTone(nextAssistantMessage.text)
            if (tone !== current.conversationTone) {
              current.conversationTone = tone
            }
          }
        }

        if (
          assistantPersisted
          && isHeartbeatRun
          && shouldAutoRouteHeartbeatAlerts(heartbeatConfig)
          && heartbeatConfig?.target
          && heartbeatConfig.target !== 'none'
        ) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { sendConnectorMessage } = require('../connectors/manager')
            let connectorId: string | undefined
            let channelId: string | undefined
            if (heartbeatConfig.target === 'last') {
              const lastTarget = resolveHeartbeatLastConnectorTarget(current)
              if (lastTarget) {
                connectorId = lastTarget.connectorId
                channelId = lastTarget.channelId
              }
            } else if (heartbeatConfig.target.includes(':')) {
              const [cId, chId] = heartbeatConfig.target.split(':', 2)
              connectorId = cId
              channelId = chId
            } else {
              channelId = heartbeatConfig.target
            }
            if (channelId) {
              sendConnectorMessage({ connectorId, channelId, text: nextAssistantMessage.text }).catch((err: unknown) => {
                log.warn('connector', 'Heartbeat connector delivery failed', {
                  connectorId,
                  channelId,
                  sessionId,
                  error: typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : String(err),
                })
              })
            }
          } catch {
            // Best effort — connector manager may not be loaded.
          }
        }

        if (
          assistantPersisted
          && isHeartbeatRun
          && shouldAutoRouteHeartbeatAlerts(heartbeatConfig)
          && !heartbeatConfig?.target
          && isDirectConnectorSession(current)
        ) {
          const recentInbound = current.connectorContext?.lastInboundAt
            && (Date.now() - current.connectorContext.lastInboundAt) < 60_000
          const connectorId = typeof current.connectorContext?.connectorId === 'string'
            ? current.connectorContext.connectorId.trim()
            : ''
          const channelId = typeof current.connectorContext?.channelId === 'string'
            ? current.connectorContext.channelId.trim()
            : ''
          if (!recentInbound && channelId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { sendConnectorMessage: sendMsg } = require('../connectors/manager')
              sendMsg({ connectorId: connectorId || undefined, channelId, text: nextAssistantMessage.text }).catch((err: unknown) => {
                log.warn('connector', 'Auto-route connector delivery failed', {
                  connectorId,
                  channelId,
                  sessionId,
                  error: typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : String(err),
                })
              })
            } catch {
              // Best effort — connector manager may not be loaded.
            }
          }
        }
      }
    }
    if (isHeartbeatRun && heartbeatClassification === 'suppress') {
      if (pruneSuppressedHeartbeatStreamMessage(messages)) messagesPruned = true
    }

    if (isHeartbeatRun) {
      const pruned = pruneOldHeartbeatMessages(messages)
      if (pruned > 0) {
        messagesPruned = true
        log.info('heartbeat', `Pruned ${pruned} old heartbeat message(s) from session ${sessionId}`)
      }
    }

    // Persist messages: use O(1) append/replace when no pruning, O(n) replaceAll when pruned
    if (messagesPruned) {
      replaceAllMessages(sessionId, messages)
    } else if (assistantPersisted && persistedAssistantMsg) {
      if (replacedLast) {
        replaceMessageAt(sessionId, getMessageCount(sessionId) - 1, persistedAssistantMsg)
      } else {
        appendMessage(sessionId, persistedAssistantMsg)
      }
    }

    try {
      await runCapabilityHook('afterChatTurn', {
        session: current,
        message,
        response: persistedResponseForHooks,
        source,
        internal,
        toolEvents: persistedToolEvents,
      }, { enabledIds: extensionsForRun })
    } catch {
      // afterChatTurn hooks are non-critical.
    }

    if (!isHeartbeatSource(source)) {
      current.lastActiveAt = Date.now()
    }

    refreshSessionIdentityState(current, currentAgent)
    let resolvedMissionId = mission?.id || current.missionId || null
    let updatedMission = mission || null
    if (resolvedMissionId) {
      updatedMission = await applyMissionOutcomeForTurn({
        session: current,
        missionId: resolvedMissionId,
        source,
        runId: lifecycleRunId,
        message,
        assistantText: hiddenControlOnly ? '' : textForPersistence,
        error: errorMessage || null,
        toolEvents: persistedToolEvents,
      })
      if (updatedMission?.id) {
        resolvedMissionId = updatedMission.id
        current.missionId = updatedMission.id
      }
    }
    const missionStateChanged = Boolean(
      updatedMission
      && (
        updatedMission.id !== mission?.id
        || updatedMission.updatedAt !== mission?.updatedAt
        || updatedMission.status !== mission?.status
        || updatedMission.phase !== mission?.phase
        || updatedMission.currentStep !== mission?.currentStep
        || updatedMission.waitState?.reason !== mission?.waitState?.reason
      )
    )
    const shouldSyncWorkingState = (
      (!isHeartbeatRun && (assistantPersisted || persistedToolEvents.length > 0 || Boolean(errorMessage)))
      || (isHeartbeatRun && (persistedToolEvents.length > 0 || Boolean(errorMessage) || missionStateChanged))
    )
    if (shouldSyncWorkingState) {
      try {
        await synchronizeWorkingStateForTurn({
          sessionId,
          agentId: current.agentId || null,
          mission: updatedMission,
          message,
          assistantText: hiddenControlOnly ? '' : textForPersistence,
          error: errorMessage || null,
          toolEvents: persistedToolEvents,
          runId: lifecycleRunId,
          source,
        })
      } catch (workingStateError: unknown) {
        log.warn('chat-run', `Working-state sync failed for session ${sessionId}`, {
          runId: lifecycleRunId,
          error: typeof workingStateError === 'object' && workingStateError !== null && 'message' in workingStateError
            ? (workingStateError as Error).message
            : String(workingStateError),
        })
      }
    }
    try {
      syncSessionArchiveMemory(current, { agent: currentAgent })
    } catch {
      // Archive sync is best-effort.
    }
    saveSession(sessionId, current)
    if (current.agentId && shouldAutoDraftSkillSuggestion({
      assistantPersisted,
      internal,
      isHeartbeatRun,
      agentAutoDraftSetting: currentAgent?.autoDraftSkillSuggestions === true,
      toolEventCount: persistedToolEvents.length,
      messageCount: messages.length,
    })) {
      try {
        const { createSkillSuggestionFromSession } = await import('@/lib/server/skills/skill-suggestions')
        await createSkillSuggestionFromSession(sessionId)
      } catch {
        // Reviewed skill drafting is best-effort.
      }
    }
    notify(`messages:${sessionId}`)
  }

  endPostProcessPerf({ toolEventCount: persistedToolEvents.length })

  return {
    runId,
    sessionId,
    missionId: mission?.id || null,
    text: hiddenControlOnly ? '' : textForPersistence,
    persisted: assistantPersisted,
    toolEvents: persistedToolEvents,
    error: errorMessage,
    inputTokens: accumulatedUsage.inputTokens || undefined,
    outputTokens: accumulatedUsage.outputTokens || undefined,
    estimatedCost: accumulatedUsage.estimatedCost || undefined,
  }
}
