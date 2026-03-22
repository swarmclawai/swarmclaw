import { log } from '@/lib/server/logger'
import { genId } from '@/lib/id'
import {
  loadConnectors,
  loadSession,
  loadAgents, loadCredentials, decryptKey, loadSettings, loadSkills,
  loadChatrooms, saveChatrooms,
} from '../storage'
import { getMessages } from '@/lib/server/messages/message-repository'
import { dedup, errorMessage, hmrSingleton } from '@/lib/shared-utils'
import path from 'path'
import { streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { notify } from '../ws-hub'
import { logExecution } from '../execution-log'
import { buildCurrentDateTimePromptContext } from '../prompt-runtime-context'
import {
  parseMentions,
  compactChatroomMessages,
  buildChatroomSystemPrompt,
  ensureSyntheticSession,
  buildAgentSystemPromptForChatroom,
  buildHistoryForAgent,
  resolveApiKey as resolveApiKeyHelper,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { filterHealthyChatroomAgents } from '@/lib/server/chatrooms/chatroom-health'
import {
  ensureChatroomRoutingGuidance,
  selectChatroomRecipients,
} from '@/lib/server/chatrooms/chatroom-routing'
import { markProviderFailure, markProviderSuccess } from '../provider-health'
import { buildIdentityContinuityContext } from '../identity-continuity'
import { buildRuntimeSkillPromptBlocks, resolveRuntimeSkills } from '@/lib/server/skills/runtime-skill-resolver'
import { getProvider } from '@/lib/providers'
import type { Connector, MessageSource, MessageToolEvent, Chatroom, ChatroomMessage, Session } from '@/types'
import type { InboundMessage } from './types'
import {
  parsePairingPolicy,
} from './pairing'
import { enrichInboundMessageWithAudioTranscript } from './inbound-audio-transcription'
import {
  parseConnectorCommand as parseConnectorCommandExtracted,
  handleConnectorCommand as handleConnectorCommandExtracted,
  handlePairCommand as handlePairCommandExtracted,
} from './commands'
import {
  buildInboundDebounceKey,
  buildInboundDedupeKey,
  isReplyToLastOutbound,
  mergeInboundMessages,
  resolveConnectorSessionPolicy,
  shouldReplyToInboundMessage,
  textMentionsAlias,
} from './policy'
import { buildConnectorThreadContextBlock } from './thread-context'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import {
  applyConnectorAccessMetadata,
  buildConnectorAddressAliases,
  enforceInboundAccessPolicy as enforceInboundAccessPolicyHelper,
} from './access'
import {
  findDirectSessionForInbound as findDirectSessionForInboundHelper,
  modelHistoryTailWithAttribution,
  persistSessionRecord as persistSessionRecordCanonical,
  pushSessionMessage as pushSessionMessageHelper,
  resolveDirectSession as resolveDirectSessionHelper,
  updateSessionConnectorContext as updateSessionConnectorContextCanonical,
} from './session'
import { NO_MESSAGE_SENTINEL, isNoMessage } from './message-sentinel'
import {
  buildInboundAttachmentPaths,
  connectorSupportsBinaryMedia,
  extractEmbeddedMedia,
  formatInboundUserText,
  normalizeWhatsappTarget,
  parseConnectorToolInput,
  parseConnectorToolResult,
  parseSseDataEvents,
  selectOutboundMediaFiles,
  visibleConnectorToolText,
} from './response-media'
import {
  getConnectorReplySendOptions,
  maybeSendStatusReaction,
} from './delivery'
import { connectorRuntimeState, runningConnectors } from './runtime-state'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import {
  buildSenderPreferenceContextBlock,
  resolveSenderPreferencePolicy,
} from './contact-preferences'
import { prepareConnectorVoiceNotePayload } from './voice-note'
import { reconcileConnectorDeliveryText } from '@/lib/server/chat-execution/chat-execution-connector-delivery'
import { pruneIncompleteToolEvents, updateStreamedToolEvents } from '@/lib/server/chat-execution/chat-streaming-utils'
import { guardUntrustedText, getUntrustedContentGuardMode } from '@/lib/server/untrusted-content'
import {
  acquireExternalSessionExecutionHold,
  enqueueSessionRun,
  getSessionExecutionState,
} from '@/lib/server/runtime/session-run-manager'
import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution'

const TAG = 'connector-inbound'

type ConnectorSession = Session
type CurrentChannelConnectorDelivery = {
  mode: 'text' | 'voice_note'
  messageId?: string
  transcripts: string[]
}

let streamAgentChatImpl = streamAgentChat

export function setStreamAgentChatForTest(
  handler: typeof streamAgentChat | null,
): void {
  streamAgentChatImpl = handler || streamAgentChat
}

const running = runningConnectors
const {
  lastInboundChannelByConnector,
  lastInboundTimeByConnector,
  recentInboundByKey,
  pendingInboundDebounce,
  scheduledFollowupByDedupe,
  routeMessageHandlerRef,
} = connectorRuntimeState

const activeDirectConnectorSessionCounts = hmrSingleton<Map<string, number>>('__swarmclaw_connector_active_sessions__', () => new Map())

function pruneTransientConnectorState(now = Date.now()): void {
  for (const [key, seenAt] of recentInboundByKey.entries()) {
    if (now - seenAt > 120_000) recentInboundByKey.delete(key)
  }
  for (const [key, entry] of scheduledFollowupByDedupe.entries()) {
    if (entry.sendAt <= now) scheduledFollowupByDedupe.delete(key)
  }
}

function rememberRecentInbound(key: string, now = Date.now(), ttlMs = 120_000): boolean {
  pruneTransientConnectorState(now)
  const previous = recentInboundByKey.get(key) || 0
  if (previous && now - previous < ttlMs) return false
  recentInboundByKey.set(key, now)
  return true
}

function findDirectSessionForInbound(connector: Connector, msg: InboundMessage): ConnectorSession | null {
  return findDirectSessionForInboundHelper(connector, msg)
}

function startConnectorTypingLoop(connector: Connector, msg: InboundMessage): (() => void) | null {
  const session = findDirectSessionForInbound(connector, msg)
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (!policy.typingIndicators) return null
  const instance = running.get(connector.id)
  if (!instance?.sendTyping) return null
  const replyOptions = shouldReplyToInboundMessage({ msg, session, policy })

  const sendTyping = () => {
    void instance.sendTyping?.(msg.channelId, { threadId: replyOptions.threadId }).catch(() => {
      // Best effort only.
    })
  }

  sendTyping()
  const timer = setInterval(sendTyping, 4_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

async function flushDebouncedInbound(key: string): Promise<void> {
  const entry = pendingInboundDebounce.get(key)
  if (!entry) return
  pendingInboundDebounce.delete(key)
  clearTimeout(entry.timer)
  const merged = mergeInboundMessages(entry.messages)
  const response = await routeMessageHandlerRef.current(entry.connector, merged)
  if (isNoMessage(response)) {
    return
  }
  const replyOptions = getConnectorReplySendOptions({ connectorId: entry.connector.id, inbound: merged })
  const session = findDirectSessionForInbound(entry.connector, merged)
  const { sendConnectorMessage } = await import('./connector-outbound')
  await sendConnectorMessage({
    connectorId: entry.connector.id,
    channelId: merged.channelId,
    text: response,
    sessionId: session?.id,
    replyToMessageId: replyOptions.replyToMessageId,
    threadId: replyOptions.threadId,
  })
  await maybeSendStatusReaction(entry.connector, merged, 'sent')
}

async function routeOrDebounceInbound(connector: Connector, msg: InboundMessage): Promise<string> {
  const dedupeKey = buildInboundDedupeKey(connector, msg)
  const dedupeTtlMs = dedupeKey.startsWith('msg:') ? 120_000 : 15_000
  if (!rememberRecentInbound(dedupeKey, Date.now(), dedupeTtlMs)) return NO_MESSAGE_SENTINEL

  const session = findDirectSessionForInbound(connector, msg)
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (policy.inboundDebounceMs <= 0) {
    return routeMessageHandlerRef.current(connector, msg)
  }

  const debounceKey = buildInboundDebounceKey(connector, msg)
  const pending = pendingInboundDebounce.get(debounceKey)
  if (pending) {
    pending.messages.push(msg)
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      void flushDebouncedInbound(debounceKey).catch((err: unknown) => {
        log.warn(TAG, `Debounced inbound flush failed: ${errorMessage(err)}`)
      })
    }, policy.inboundDebounceMs)
    pending.timer.unref?.()
  } else {
    const timer = setTimeout(() => {
      void flushDebouncedInbound(debounceKey).catch((err: unknown) => {
        log.warn(TAG, `Debounced inbound flush failed: ${errorMessage(err)}`)
      })
    }, policy.inboundDebounceMs)
    timer.unref?.()
    pendingInboundDebounce.set(debounceKey, {
      connector,
      messages: [msg],
      timer,
    })
  }
  return NO_MESSAGE_SENTINEL
}

export function dispatchInboundConnectorMessage(
  connectorId: string,
  fallbackConnector: Connector,
  msg: InboundMessage,
): Promise<string> {
  const connectors = loadConnectors()
  const currentConnector = connectors[connectorId] as Connector | undefined
  return routeOrDebounceInbound(currentConnector ?? fallbackConnector, msg)
}

function persistSessionRecord(session: ConnectorSession): void {
  persistSessionRecordCanonical(session)
}

function updateSessionConnectorContext(session: ConnectorSession, connector: Connector, msg: InboundMessage, sessionKey: string): void {
  updateSessionConnectorContextCanonical(session, connector, msg, sessionKey)
}


function evaluateGroupPolicy(params: {
  connector: Connector
  msg: InboundMessage
  session?: ConnectorSession | null
  aliases: string[]
}): { allowed: boolean; reason: string } {
  const { connector, msg, session, aliases } = params
  if (!msg.isGroup) return { allowed: true, reason: 'dm' }
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (policy.groupPolicy === 'open') return { allowed: true, reason: 'open' }
  if (policy.groupPolicy === 'disabled') return { allowed: false, reason: 'disabled' }
  const mentioned = !!msg.mentionsBot || textMentionsAlias(msg.text || '', aliases)
  const replied = isReplyToLastOutbound(msg, session)
  if (policy.groupPolicy === 'mention') {
    return { allowed: mentioned, reason: mentioned ? 'mentioned' : 'mention_required' }
  }
  const allowed = mentioned || replied
  return { allowed, reason: allowed ? (mentioned ? 'mentioned' : 'reply') : 'reply_or_mention_required' }
}

function pushSessionMessage(
  session: ConnectorSession,
  role: 'user' | 'assistant',
  text: string,
  extra: Record<string, unknown> = {},
): void {
  pushSessionMessageHelper(session, role, text, extra)
}

function buildConnectorAssistantSource(params: {
  connector: Connector
  msg: InboundMessage
  messageId?: string
  deliveryMode?: 'text' | 'voice_note'
  deliveryTranscript?: string | null
}): MessageSource {
  return {
    platform: params.connector.platform,
    connectorId: params.connector.id,
    connectorName: params.connector.name,
    channelId: params.msg.channelId,
    senderId: params.msg.senderId,
    senderName: params.msg.senderName,
    messageId: params.messageId,
    replyToMessageId: params.msg.messageId,
    threadId: params.msg.threadId,
    deliveryMode: params.deliveryMode,
    deliveryTranscript: params.deliveryTranscript || null,
  }
}

function connectorDeliveryMarkerText(mode: 'text' | 'voice_note'): string {
  return mode === 'voice_note' ? 'Voice note delivered.' : 'Message delivered.'
}

function persistConnectorDeliveryMarker(params: {
  session: ConnectorSession
  connector: Connector
  msg: InboundMessage
  delivery: CurrentChannelConnectorDelivery
}): void {
  const transcript = dedup(params.delivery.transcripts.map((entry) => entry.trim()).filter(Boolean)).join('\n\n') || null
  pushSessionMessage(params.session, 'assistant', connectorDeliveryMarkerText(params.delivery.mode), {
    kind: 'connector-delivery',
    historyExcluded: true,
    source: buildConnectorAssistantSource({
      connector: params.connector,
      msg: params.msg,
      messageId: params.delivery.messageId,
      deliveryMode: params.delivery.mode,
      deliveryTranscript: transcript,
    }),
  })
  params.session.connectorContext = {
    ...(params.session.connectorContext || {}),
    lastOutboundAt: Date.now(),
    lastOutboundMessageId: params.delivery.messageId || params.session.connectorContext?.lastOutboundMessageId || null,
  }
  persistSessionRecord(params.session)
  notify(`messages:${params.session.id}`)
}



function connectorCanSendBinaryMedia(connector: Connector): boolean {
  const liveInstance = running.get(connector.id)
  if (typeof liveInstance?.supportsBinaryMedia === 'boolean') {
    return liveInstance.supportsBinaryMedia
  }
  return connectorSupportsBinaryMedia(connector.platform)
}

function connectorEmptyReplyFallback(streamErrorText: string): string {
  if (/abort|timed?\s*out|network|socket|connection/i.test(streamErrorText)) {
    return 'Sorry, I hit a temporary issue while responding. Please try again.'
  }
  return 'Sorry, I could not produce a reply just now. Please try again.'
}

/**
 * Check whether a connector_message_tool delivery matches the inbound channel.
 * For WhatsApp, bridges LID <-> phone JID via `allKnownPeerIds` accumulated on
 * the session (since `normalizeWhatsappTarget` can't convert between them).
 */
function isConnectorToolDeliveryMatch(params: {
  platform: string
  inboundChannelId: string
  outboundTo: string
  allKnownPeerIds?: string[] | null
}): boolean {
  const { platform, inboundChannelId, outboundTo, allKnownPeerIds } = params
  if (platform === 'whatsapp') {
    const inbound = normalizeWhatsappTarget(inboundChannelId)
    const outbound = normalizeWhatsappTarget(outboundTo)
    if (inbound && outbound && inbound === outbound) return true
    // Bridge LID <-> phone via known peer IDs accumulated on the session
    if (allKnownPeerIds?.length) {
      const peerSet = new Set(allKnownPeerIds.map(normalizeWhatsappTarget).filter(Boolean))
      if (peerSet.has(inbound) && peerSet.has(outbound)) return true
    }
    return false
  }
  return inboundChannelId === outboundTo
}

function collectCurrentChannelConnectorDelivery(params: {
  connector: Connector
  msg: InboundMessage
  session: ConnectorSession
  toolEvents: MessageToolEvent[]
}): CurrentChannelConnectorDelivery | null {
  let delivery: CurrentChannelConnectorDelivery | null = null
  for (const event of params.toolEvents) {
    if (event.name !== 'connector_message_tool') continue
    const parsed = parseConnectorToolResult(event.output || '')
    if (!parsed?.status || !parsed.to) continue
    const sentLikeStatus = parsed.status === 'sent' || parsed.status === 'voice_sent'
    if (!sentLikeStatus) continue
    const isCurrentChannel = isConnectorToolDeliveryMatch({
      platform: params.connector.platform,
      inboundChannelId: params.msg.channelId,
      outboundTo: parsed.to,
      allKnownPeerIds: params.session.connectorContext?.allKnownPeerIds,
    })
    if (!isCurrentChannel) continue
    if (!delivery) {
      delivery = {
        mode: parsed.status === 'voice_sent' ? 'voice_note' : 'text',
        messageId: parsed.messageId,
        transcripts: [],
      }
    } else {
      if (parsed.status === 'voice_sent') delivery.mode = 'voice_note'
      if (parsed.messageId) delivery.messageId = parsed.messageId
    }
    const transcript = visibleConnectorToolText(parseConnectorToolInput(event.input || ''))
    if (transcript) delivery.transcripts.push(transcript)
  }
  return delivery
}

export async function deliverQueuedConnectorRunResult(params: {
  connector: Connector
  msg: InboundMessage
  sessionId: string
  result: ExecuteChatTurnResult
  preferredReplyMedium?: 'text' | 'voice_note' | null
}): Promise<void> {
  const session = loadSession(params.sessionId) as ConnectorSession | undefined
  if (!session) return

  let fullText = (params.result.text || '').trim()
  if (!fullText && params.result.error) fullText = `[Error] ${params.result.error}`
  const currentChannelDelivery = collectCurrentChannelConnectorDelivery({
    connector: params.connector,
    msg: params.msg,
    session,
    toolEvents: params.result.toolEvents || [],
  })
  fullText = reconcileConnectorDeliveryText(fullText, params.result.toolEvents || []).trim()

  if (!fullText && !currentChannelDelivery) {
    await maybeSendStatusReaction(params.connector, params.msg, 'silent')
    return
  }

  if (currentChannelDelivery) {
    persistConnectorDeliveryMarker({
      session,
      connector: params.connector,
      msg: params.msg,
      delivery: currentChannelDelivery,
    })
    await maybeSendStatusReaction(params.connector, params.msg, 'sent')
    return
  }

  const extracted = extractEmbeddedMedia(fullText)
  const filesToSend = selectOutboundMediaFiles(extracted.files, params.msg.text || '')
  if (filesToSend.length > 0) {
    const replyOptions = getConnectorReplySendOptions({
      connectorId: params.connector.id,
      inbound: params.msg,
    })
    const { sendConnectorMessage } = await import('./connector-outbound')
    for (const file of filesToSend) {
      await sendConnectorMessage({
        connectorId: params.connector.id,
        channelId: params.msg.channelId,
        text: '',
        sessionId: session.id,
        mediaPath: file.path,
        caption: file.alt || undefined,
        replyToMessageId: replyOptions.replyToMessageId,
        threadId: replyOptions.threadId,
      })
    }
  }

  let outboundText = (filesToSend.length > 0 ? extracted.cleanText : fullText).trim()
  if (params.preferredReplyMedium === 'voice_note' && outboundText) {
    if (!connectorCanSendBinaryMedia(params.connector)) {
      outboundText = `I couldn't send a voice note on this channel because the connector doesn't support audio attachments.`
    } else {
      const replyOptions = getConnectorReplySendOptions({
        connectorId: params.connector.id,
        inbound: params.msg,
      })
      const voicePayload = await prepareConnectorVoiceNotePayload({
        voiceText: outboundText,
        sessionAgentId: session.agentId || params.connector.agentId || '',
        contextAgentId: session.agentId || params.connector.agentId || '',
      })
      const { sendConnectorMessage } = await import('./connector-outbound')
      const sent = await sendConnectorMessage({
        connectorId: params.connector.id,
        channelId: params.msg.channelId,
        text: '',
        sessionId: session.id,
        mediaPath: voicePayload.mediaPath,
        mimeType: voicePayload.mimeType,
        fileName: voicePayload.fileName,
        replyToMessageId: replyOptions.replyToMessageId,
        threadId: replyOptions.threadId,
        ptt: true,
      })
      persistConnectorDeliveryMarker({
        session,
        connector: params.connector,
        msg: params.msg,
        delivery: {
          mode: 'voice_note',
          messageId: sent.messageId,
          transcripts: [outboundText],
        },
      })
      await maybeSendStatusReaction(params.connector, params.msg, 'sent')
      return
    }
  }

  if (outboundText) {
    const replyOptions = getConnectorReplySendOptions({
      connectorId: params.connector.id,
      inbound: params.msg,
    })
    const { sendConnectorMessage } = await import('./connector-outbound')
    await sendConnectorMessage({
      connectorId: params.connector.id,
      channelId: params.msg.channelId,
      text: outboundText,
      sessionId: session.id,
      replyToMessageId: replyOptions.replyToMessageId,
      threadId: replyOptions.threadId,
    })
    await maybeSendStatusReaction(params.connector, params.msg, 'sent')
    return
  }

  if (filesToSend.length > 0) {
    await maybeSendStatusReaction(params.connector, params.msg, 'sent')
    return
  }

  await maybeSendStatusReaction(params.connector, params.msg, 'silent')
}


async function enforceInboundAccessPolicy(params: {
  connector: Connector
  msg: InboundMessage
  session?: { connectorContext?: { lastOutboundMessageId?: string | null } } | null
  aliases?: string[]
}): Promise<string | null> {
  return enforceInboundAccessPolicyHelper({
    connector: params.connector,
    msg: params.msg,
    noMessageSentinel: NO_MESSAGE_SENTINEL,
    session: params.session,
    aliases: params.aliases,
  })
}

/** Route an inbound message to a chatroom — process mentioned agents and return concatenated responses */
async function routeMessageToChatroom(connector: Connector, msg: InboundMessage): Promise<string> {
  const chatroomId = connector.chatroomId
  if (!chatroomId) return '[Error] No chatroom configured.'

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[chatroomId] as Chatroom | undefined
  if (!chatroom) return '[Error] Chatroom not found.'

  const agents = loadAgents()
  const chatroomAgentAliases = chatroom.agentIds
    .map((agentId) => agents[agentId]?.name)
    .filter((name): name is string => typeof name === 'string' && !!name.trim())
  const preferredCredentialId = (() => {
    if (connector.agentId && agents[connector.agentId]?.credentialId) {
      return agents[connector.agentId].credentialId as string
    }
    for (const agentId of chatroom.agentIds) {
      const credentialId = agents[agentId]?.credentialId
      if (credentialId) return credentialId as string
    }
    return null
  })()
  msg = await enrichInboundMessageWithAudioTranscript({
    msg,
    preferredCredentialId,
  })
  const accessPolicyResult = await enforceInboundAccessPolicy({
    connector,
    msg,
    aliases: buildConnectorAddressAliases({
      connectorName: connector.name,
      aliases: chatroomAgentAliases,
    }),
  })
  if (accessPolicyResult) {
    return accessPolicyResult
  }
  const groupGate = evaluateGroupPolicy({
    connector,
    msg,
    aliases: [connector.name, ...chatroomAgentAliases],
  })
  if (!groupGate.allowed) return NO_MESSAGE_SENTINEL

  await maybeSendStatusReaction(connector, msg, 'processing')
  const stopTyping = startConnectorTypingLoop(connector, msg)
  try {

  const source: MessageSource = {
    platform: connector.platform,
    connectorId: connector.id,
    connectorName: connector.name,
    channelId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageId: msg.messageId,
    replyToMessageId: msg.replyToMessageId,
    threadId: msg.threadId,
  }
  const guardMode = getUntrustedContentGuardMode(loadSettings())
  const trustedInbound = msg.isOwnerConversation === true
  const guardedRawText = guardUntrustedText({
    text: msg.text || '',
    source: `${connector.platform} connector message`,
    mode: guardMode,
    trusted: trustedInbound,
  }).text
  const guardedInboundText = guardUntrustedText({
    text: formatInboundUserText(msg),
    source: `${connector.platform} connector message`,
    mode: guardMode,
    trusted: trustedInbound,
  }).text
  const inboundText = guardedInboundText
  const inboundAttachmentPaths = buildInboundAttachmentPaths(msg)
  const firstImagePath = msg.media?.find((m) => m.type === 'image')?.localPath
  const threadContextBlock = buildConnectorThreadContextBlock(msg)

  // Parse mentions from the message text
  ensureChatroomRoutingGuidance(chatroom, agents)
  let mentions = parseMentions(msg.text || '', agents, chatroom.agentIds)
  if (mentions.length === 0 && !chatroom.autoAddress) {
    mentions = await selectChatroomRecipients({
      text: msg.text || '',
      chatroom,
      agentsById: agents,
    })
  }
  // Auto-address: if enabled and still no mentions, address all agents
  if (chatroom.autoAddress && mentions.length === 0) {
    mentions = [...chatroom.agentIds]
  }
  const mentionHealth = filterHealthyChatroomAgents(mentions, agents)
  mentions = mentionHealth.healthyAgentIds

  // Create and persist the user message in the chatroom
  const userMessage: ChatroomMessage = {
    id: genId(),
    senderId: 'user',
    senderName: msg.senderName || 'User',
    role: 'user',
    text: guardedRawText,
    mentions,
    reactions: [],
    time: Date.now(),
    ...(firstImagePath ? { imagePath: firstImagePath } : {}),
    ...(inboundAttachmentPaths.length ? { attachedFiles: inboundAttachmentPaths } : {}),
    source,
  }
  chatroom.messages.push(userMessage)
  compactChatroomMessages(chatroom)
  chatroom.updatedAt = Date.now()
  chatrooms[chatroomId] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${chatroomId}`)

  if (mentions.length === 0) {
    if (mentionHealth.skipped.length > 0) {
      const skippedSummary = mentionHealth.skipped
        .map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`)
        .join(', ')
      return `[Error] No healthy agents were available for this request. Skipped: ${skippedSummary}`
    }
    return '[Error] No agents were selected for this request.'
  }

  // Process mentioned agents sequentially and collect responses
  const responses: string[] = []
  for (const agentId of mentions) {
    const agent = agents[agentId]
    if (!agent) continue

    const apiKey = resolveApiKeyHelper(agent.credentialId)
    const freshChatrooms = loadChatrooms()
    const freshChatroom = freshChatrooms[chatroomId] as Chatroom
    if (compactChatroomMessages(freshChatroom)) {
      freshChatrooms[chatroomId] = freshChatroom
      saveChatrooms(freshChatrooms)
      notify(`chatroom:${chatroomId}`)
    }

    const providerInfo = getProvider(agent.provider)
    if (providerInfo?.requiresApiKey && !apiKey) {
      markProviderFailure(agent.provider, 'missing_api_credentials')
      responses.push(`[${agent.name}] [Error] Missing API credentials.`)
      continue
    }
    if (providerInfo?.requiresEndpoint && !agent.apiEndpoint) {
      markProviderFailure(agent.provider, 'missing_api_endpoint')
      responses.push(`[${agent.name}] [Error] Missing endpoint configuration.`)
      continue
    }

    const syntheticSession = ensureSyntheticSession(agent, chatroomId)
    const agentSystemPrompt = buildAgentSystemPromptForChatroom(agent, syntheticSession.cwd)
    const chatroomContext = buildChatroomSystemPrompt(freshChatroom, agents, agent.id)
    const fullSystemPrompt = [agentSystemPrompt, chatroomContext, threadContextBlock].filter(Boolean).join('\n\n')
    const history = buildHistoryForAgent(freshChatroom, agent.id)

    try {
      const result = await streamAgentChat({
        session: syntheticSession,
        message: inboundText,
        imagePath: firstImagePath || undefined,
        attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
        apiKey,
        systemPrompt: fullSystemPrompt,
        write: () => {},
        history,
      })

      const responseText = stripHiddenControlTokens(result.finalResponse || result.fullText)
      if (responseText.trim() && !isNoMessage(responseText)) {
        // Persist agent response to chatroom
        const agentSource: MessageSource = {
          platform: connector.platform,
          connectorId: connector.id,
          connectorName: connector.name,
          channelId: msg.channelId,
        }
        const agentMessage: ChatroomMessage = {
          id: genId(),
          senderId: agent.id,
          senderName: agent.name,
          role: 'assistant',
          text: responseText,
          mentions: filterHealthyChatroomAgents(
            parseMentions(responseText, agents, freshChatroom.agentIds, { senderId: agent.id }),
            agents,
          ).healthyAgentIds,
          reactions: [],
          time: Date.now(),
          source: agentSource,
        }
        const latestChatrooms = loadChatrooms()
        const latestChatroom = latestChatrooms[chatroomId] as Chatroom
        latestChatroom.messages.push(agentMessage)
        latestChatroom.updatedAt = Date.now()
        latestChatrooms[chatroomId] = latestChatroom
        saveChatrooms(latestChatrooms)
        notify(`chatroom:${chatroomId}`)

        markProviderSuccess(agent.provider)
        responses.push(`[${agent.name}] ${responseText}`)
      } else {
        markProviderSuccess(agent.provider)
      }
    } catch (err: unknown) {
      const errMsg = errorMessage(err)
      markProviderFailure(agent.provider, errMsg)
      log.error(TAG, `Chatroom agent ${agent.name} error:`, errMsg)
    }
  }

  if (responses.length === 0) {
    await maybeSendStatusReaction(connector, msg, 'silent')
    return NO_MESSAGE_SENTINEL
  }

  const joined = responses.join('\n\n')
  // Extract embedded media from agent responses and send them via connector
  const extracted = extractEmbeddedMedia(joined)
  const filesToSend = selectOutboundMediaFiles(extracted.files, msg.text || '')
  if (filesToSend.length > 0) {
    const inst = running.get(connector.id)
    if (inst?.sendMessage) {
      const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound: msg })
      const { sendConnectorMessage } = await import('./connector-outbound')
      for (const file of filesToSend) {
        try {
          await sendConnectorMessage({
            connectorId: connector.id,
            channelId: msg.channelId,
            text: '',
            mediaPath: file.path,
            caption: file.alt || undefined,
            replyToMessageId: replyOptions.replyToMessageId,
            threadId: replyOptions.threadId,
          })
          log.info(TAG, `Sent chatroom media to ${msg.platform}: ${path.basename(file.path)}`)
        } catch (err: unknown) {
          log.error(TAG, `Failed to send chatroom media ${path.basename(file.path)}:`, errorMessage(err))
        }
      }
    }
    return extracted.cleanText || '(no response)'
  }
  return joined
  } finally {
    stopTyping?.()
  }
}

/** Route an inbound message through the assigned agent and return the response */
async function routeMessage(connector: Connector, msg: InboundMessage): Promise<string> {
  if (msg?.channelId) {
    lastInboundChannelByConnector.set(connector.id, msg.channelId)
  }
  lastInboundTimeByConnector.set(connector.id, Date.now())
  msg = applyConnectorAccessMetadata(connector, msg)

  // Route to chatroom if configured
  if (connector.chatroomId) {
    return routeMessageToChatroom(connector, msg)
  }

  const agents = loadAgents()
  const effectiveAgentId = msg.agentIdOverride || connector.agentId
  if (!effectiveAgentId) return '[Error] Connector has no agent configured.'
  const agent = agents[effectiveAgentId]
  if (!agent) return '[Error] Connector agent not found.'
  msg = await enrichInboundMessageWithAudioTranscript({
    msg,
    preferredCredentialId: agent.credentialId || null,
  })

  const { session, sessionKey, wasCreated, staleReason, clearedMessages } = resolveDirectSessionHelper({
    connector,
    msg,
    agent,
  })
  const senderPreferencePolicy = resolveSenderPreferencePolicy({
    agent,
    session,
    msg,
  })
  const guardMode = getUntrustedContentGuardMode(loadSettings())
  const trustedInbound = msg.isOwnerConversation === true
  const rawText = guardUntrustedText({
    text: (msg.text || '').trim(),
    source: `${connector.platform} connector message`,
    mode: guardMode,
    trusted: trustedInbound,
  }).text
  const inboundText = guardUntrustedText({
    text: formatInboundUserText(msg),
    source: `${connector.platform} connector message`,
    mode: guardMode,
    trusted: trustedInbound,
  }).text
  const messageSource: MessageSource = {
    platform: connector.platform,
    connectorId: connector.id,
    connectorName: connector.name,
    channelId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageId: msg.messageId,
    replyToMessageId: msg.replyToMessageId,
    threadId: msg.threadId,
  }

  const parsedCommand = parseConnectorCommandExtracted(msg.text || '')
  const accessPolicyResult = await enforceInboundAccessPolicy({
    connector,
    msg,
    session,
    aliases: buildConnectorAddressAliases({
      agentName: agent.name,
      connectorName: connector.name,
    }),
  })
  if (accessPolicyResult) {
    if (accessPolicyResult !== NO_MESSAGE_SENTINEL) {
      pushSessionMessage(session, 'user', rawText || inboundText, {
        source: messageSource,
        historyExcluded: true,
      })
      pushSessionMessage(session, 'assistant', accessPolicyResult, {
        source: buildConnectorAssistantSource({ connector, msg }),
        historyExcluded: true,
      })
      updateSessionConnectorContext(session, connector, msg, sessionKey)
      persistSessionRecord(session)
      notify(`messages:${session.id}`)
    }
    logExecution(session.id, 'decision', 'Connector inbound blocked by access policy', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
        policy: parsePairingPolicy(connector.config?.dmPolicy, 'open'),
      },
    })
    return accessPolicyResult
  }

  if (parsedCommand?.name === 'pair') {
    const commandResult = await handlePairCommandExtracted({
      connector,
      msg,
      args: parsedCommand.args,
    })
    logExecution(session.id, 'decision', 'Connector pair command handled', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        command: 'pair',
        args: parsedCommand.args || null,
      },
    })
    return commandResult
  }

  const groupGate = evaluateGroupPolicy({
    connector,
    msg,
    session,
    aliases: [agent.name, connector.name],
  })
  if (!groupGate.allowed) {
    logExecution(session.id, 'decision', 'Connector inbound blocked by group policy', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
        groupPolicy: resolveConnectorSessionPolicy(connector, msg, session).groupPolicy,
        reason: groupGate.reason,
      },
    })
    return NO_MESSAGE_SENTINEL
  }

  if (parsedCommand) {
    const commandResult = await handleConnectorCommandExtracted({
      command: parsedCommand,
      connector,
      session,
      msg,
      agentName: agent.name,
      inboundText: formatInboundUserText(msg),
    })
    logExecution(session.id, 'decision', `Connector command handled: /${parsedCommand.name}`, {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        command: parsedCommand.name,
        args: parsedCommand.args || null,
      },
    })
    return commandResult
  }

  await maybeSendStatusReaction(connector, msg, 'processing')
  const stopTyping = startConnectorTypingLoop(connector, msg)
  const releaseExternalSessionHold = acquireExternalSessionExecutionHold(session.id)
  const directRunCount = activeDirectConnectorSessionCounts.get(session.id) || 0
  activeDirectConnectorSessionCounts.set(session.id, directRunCount + 1)
  try {
    logExecution(session.id, 'trigger', `${msg.platform} message from ${msg.senderName}`, {
      agentId: agent.id,
      detail: {
        source: 'connector',
        platform: msg.platform,
        connectorId: connector.id,
        channelId: msg.channelId,
        senderName: msg.senderName,
        sessionKey,
        messagePreview: (msg.text || '').slice(0, 200),
        hasMedia: !!(msg.media?.length || msg.imageUrl),
        staleReason: staleReason || null,
        clearedMessages: clearedMessages || 0,
      },
    })

  // Resolve API key for the effective session provider, preferring matching fallback credentials.
  let apiKey: string | null = null
  const sessionCredentialIds = [
    session.credentialId,
    ...(Array.isArray(session.fallbackCredentialIds) ? session.fallbackCredentialIds : []),
  ].filter(Boolean) as string[]
  if (sessionCredentialIds.length > 0) {
    const creds = loadCredentials()
    const matching = sessionCredentialIds.find((credentialId) => creds[credentialId]?.provider === session.provider)
    const ordered = matching
      ? [matching, ...sessionCredentialIds.filter((credentialId) => credentialId !== matching)]
      : sessionCredentialIds
    for (const credentialId of ordered) {
      const cred = creds[credentialId]
      if (!cred?.encryptedKey) continue
      try {
        apiKey = decryptKey(cred.encryptedKey)
        break
      } catch {
        // Try the next candidate.
      }
    }
  }

  // Build system prompt: [identity] \n\n [userPrompt] \n\n [soul] \n\n [systemPrompt]
  const settings = loadSettings()
  const promptParts: string[] = []
  // Identity block — agent needs to know who it is
  const identityLines = [`## My Identity`, `My name is ${agent.name}.`]
  if (agent.description) identityLines.push(agent.description)
  identityLines.push('I should always refer to myself by this name. I am not "Assistant" — I have my own name and identity.')
  promptParts.push(identityLines.join(' '))
  const continuityBlock = buildIdentityContinuityContext(session as Session, agent)
  if (continuityBlock) promptParts.push(continuityBlock)
  if (typeof settings.userPrompt === 'string' && settings.userPrompt.trim()) promptParts.push(settings.userPrompt)
  promptParts.push(buildCurrentDateTimePromptContext())
  if (agent.soul) promptParts.push(agent.soul)
  if (agent.systemPrompt) promptParts.push(agent.systemPrompt)
  try {
    const enabledExtensions = dedup([
      ...getEnabledCapabilityIds(session),
      ...getEnabledCapabilityIds(agent),
    ])
    const runtimeSkills = resolveRuntimeSkills({
      cwd: session.cwd,
      enabledExtensions,
      agentId: agent.id,
      sessionId: session.id,
      userId: session.user,
      agentSkillIds: agent.skillIds || [],
      storedSkills: loadSkills(),
      selectedSkillId: session.skillRuntimeState?.selectedSkillId || null,
    })
    promptParts.push(...buildRuntimeSkillPromptBlocks(runtimeSkills))
  } catch { /* non-critical */ }
  const thinkLevel = resolveConnectorSessionPolicy(connector, msg, session).thinkingLevel || ''
  if (thinkLevel) {
    promptParts.push(`Connector thinking guidance: ${thinkLevel}. Keep responses concise and useful for chat.`)
  }
  const threadContextBlock = buildConnectorThreadContextBlock(msg, { isFirstThreadTurn: wasCreated })
  if (threadContextBlock) promptParts.push(threadContextBlock)
  const senderPreferenceBlock = buildSenderPreferenceContextBlock(
    senderPreferencePolicy,
    senderPreferencePolicy.preferredDisplayName || msg.senderName || msg.senderId,
  )
  if (senderPreferenceBlock) promptParts.push(senderPreferenceBlock)
  // Add connector context
  const groupCtx = msg.isGroup
    ? `\nThis is a group chat. History messages are prefixed with [SenderName] to show who said what. Multiple people may be participating. Address the current sender "${msg.senderName}" by name when relevant.`
    : ''
  promptParts.push(`\nYou are receiving messages via ${msg.platform}. The user "${msg.senderName}" (ID: ${msg.senderId}) is messaging from channel "${msg.channelName || msg.channelId}". Respond naturally and conversationally.${groupCtx}

## Response Style
Be action-first and autonomous: when the user gives an instruction, execute it instead of asking routine follow-up questions.
Do not end every reply with a question.
Only ask a question when a specific missing detail blocks progress.
When a task is complete, state the result plainly and stop.

## Async Update Routing
When you start work that may finish later (task, schedule, delegated run), tell the user where updates will be sent.
Default to this same ${msg.platform} chat unless the user requested another destination.
If channel preference is ambiguous and there are multiple reasonable destinations, ask one short routing question.

## Knowing When Not to Reply
Real conversations have natural pauses — not every message needs a response. Reply with exactly "NO_MESSAGE" (nothing else) to stay silent when replying would feel unnatural or forced.
Stay silent for simple acknowledgments ("okay", "alright", "cool", "got it", "sounds good"), conversation closers ("thanks", "bye", "night", "ttyl"), reactions (emoji, "haha", "lol"), and forwarded content with no question attached.
Always reply when there's a question, task, instruction, emotional sharing, or something genuinely useful to add.
The test: would a thoughtful friend feel compelled to type something back? If not, NO_MESSAGE.

## Media Delivery Rules
When the user asks to send media (image, screenshot, PDF, file, or voice note), actually call tools to send it.
Do not claim "sent" unless a tool call succeeded.
If voice note is requested, prefer connector_message_tool action=send_voice_note when available.
If media sending fails, report the exact error and retry with a corrected path/target.`)
  const systemPrompt = promptParts.join('\n\n')

  // Add message to session
  const firstImage = msg.media?.find((m) => m.type === 'image')
  const firstImageUrl = msg.imageUrl || (firstImage?.url) || undefined
  const firstImagePath = firstImage?.localPath || undefined
  const inboundAttachmentPaths = buildInboundAttachmentPaths(msg)
  const modelInputText = inboundText
  const directConnectorRunActive = directRunCount > 0
  const executionState = getSessionExecutionState(session.id)
  if (directConnectorRunActive || executionState.hasRunning || executionState.hasQueued) {
    updateSessionConnectorContext(session, connector, msg, sessionKey)
    persistSessionRecord(session)

    const queued = enqueueSessionRun({
      sessionId: session.id,
      missionId: session.missionId || null,
      message: modelInputText,
      imagePath: firstImagePath,
      imageUrl: firstImageUrl,
      attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
      source: 'chat',
      mode: 'followup',
    })

    void queued.promise.then(async (result) => {
      try {
        await deliverQueuedConnectorRunResult({
          connector,
          msg,
          sessionId: session.id,
          result,
          preferredReplyMedium: senderPreferencePolicy.preferredReplyMedium || null,
        })
      } catch (err: unknown) {
        const errText = errorMessage(err)
        log.error(TAG, 'queued follow-up delivery failed:', errText)
        try {
          const { sendConnectorMessage } = await import('./connector-outbound')
          await sendConnectorMessage({
            connectorId: connector.id,
            channelId: msg.channelId,
            text: `[Error] ${errText}`,
            sessionId: session.id,
          })
        } catch {
          // Best effort.
        }
      }
    }).catch(async (err: unknown) => {
      const errText = errorMessage(err)
      log.error(TAG, 'queued follow-up run failed:', errText)
      try {
        const { sendConnectorMessage } = await import('./connector-outbound')
        await sendConnectorMessage({
          connectorId: connector.id,
          channelId: msg.channelId,
          text: `[Error] ${errText}`,
          sessionId: session.id,
        })
      } catch {
        // Best effort.
      }
    })

    return NO_MESSAGE_SENTINEL
  }
  // Store the raw user text for display (source.senderName handles attribution).
  // The formatted text with [SenderName] prefix is only used for LLM history context.
  pushSessionMessage(session, 'user', rawText || inboundText, {
    imageUrl: firstImageUrl,
    imagePath: firstImagePath,
    attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
    source: messageSource,
  })
  updateSessionConnectorContext(session, connector, msg, sessionKey)
  persistSessionRecord(session)
  notify(`messages:${session.id}`)

  // Stream the response
  let fullText = ''
  let mediaExtractionText = ''
  let streamErrorText = ''
  let settledConnectorToolEvents: MessageToolEvent[] = []
  const connectorToolInputsByCallId = new Map<string, Record<string, unknown>>()
  const streamedConnectorToolEvents: MessageToolEvent[] = []
  const currentChannelDeliveryRef: { current: CurrentChannelConnectorDelivery | null } = { current: null }
  const noteCurrentChannelDelivery = (params: {
    mode: 'text' | 'voice_note'
    messageId?: string
    transcript?: string
  }) => {
    if (!currentChannelDeliveryRef.current) {
      currentChannelDeliveryRef.current = {
        mode: params.mode,
        messageId: params.messageId,
        transcripts: [],
      }
    } else {
      if (params.mode === 'voice_note') currentChannelDeliveryRef.current.mode = 'voice_note'
      if (params.messageId) currentChannelDeliveryRef.current.messageId = params.messageId
    }
    const transcript = typeof params.transcript === 'string' ? params.transcript.trim() : ''
    if (transcript) currentChannelDeliveryRef.current?.transcripts.push(transcript)
  }
  const hasTools = getEnabledCapabilityIds(session).length > 0 && session.provider !== 'claude-cli'
  log.info(TAG, `Routing message to agent "${agent.name}" (${session.provider}/${session.model}), hasTools=${!!hasTools}`)

  if (hasTools) {
    try {
      const toolMediaOutputs: string[] = []
      const result = await streamAgentChatImpl({
        session: session as Session,
        message: modelInputText,
        imagePath: firstImagePath,
        attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
        apiKey,
        systemPrompt,
        write: (raw) => {
          for (const event of parseSseDataEvents(raw)) {
            if (event.t === 'err') {
              const errText = typeof event.text === 'string' ? event.text.trim() : ''
              if (errText) streamErrorText = errText
              continue
            }
            if (event.t === 'tool_call' && event.toolName === 'connector_message_tool') {
              const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
              const toolInput = typeof event.toolInput === 'string' ? event.toolInput : ''
              updateStreamedToolEvents(streamedConnectorToolEvents, {
                type: 'call',
                name: 'connector_message_tool',
                input: toolInput,
                toolCallId: toolCallId || undefined,
              })
              if (toolCallId && toolInput) {
                const parsedInput = parseConnectorToolInput(toolInput)
                if (parsedInput) connectorToolInputsByCallId.set(toolCallId, parsedInput)
              }
              continue
            }
            if (event.t !== 'tool_result') continue
            const toolOutput = typeof event.toolOutput === 'string' ? event.toolOutput : ''
            if (!toolOutput) continue
            toolMediaOutputs.push(toolOutput)
            if (event.toolName === 'connector_message_tool') {
              const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
              updateStreamedToolEvents(streamedConnectorToolEvents, {
                type: 'result',
                name: 'connector_message_tool',
                output: toolOutput,
                toolCallId: toolCallId || undefined,
              })
              const mirrorInput = toolCallId ? connectorToolInputsByCallId.get(toolCallId) || null : null
              const parsed = parseConnectorToolResult(toolOutput)
              if (!parsed?.status || !parsed.to) continue
              const sentLikeStatus = parsed.status === 'sent' || parsed.status === 'voice_sent'
              if (!sentLikeStatus) continue
              const isCurrentChannel = isConnectorToolDeliveryMatch({
                platform: connector.platform,
                inboundChannelId: msg.channelId,
                outboundTo: parsed.to,
                allKnownPeerIds: session.connectorContext?.allKnownPeerIds,
              })
              if (isCurrentChannel) {
                noteCurrentChannelDelivery({
                  mode: parsed.status === 'voice_sent' ? 'voice_note' : 'text',
                  messageId: parsed.messageId,
                  transcript: visibleConnectorToolText(mirrorInput),
                })
              }
            }
          }
        },
        history: modelHistoryTailWithAttribution(getMessages(session.id), 50, 48_000),
      })
      settledConnectorToolEvents = [
        ...pruneIncompleteToolEvents(streamedConnectorToolEvents),
        ...((Array.isArray(result.toolEvents) ? result.toolEvents : []).filter((event) => event.name === 'connector_message_tool')),
      ]
      for (const event of settledConnectorToolEvents) {
        const parsed = parseConnectorToolResult(event.output || '')
        if (!parsed?.status || !parsed.to) continue
        const sentLikeStatus = parsed.status === 'sent' || parsed.status === 'voice_sent'
        if (!sentLikeStatus) continue
        const isCurrentChannel = isConnectorToolDeliveryMatch({
          platform: connector.platform,
          inboundChannelId: msg.channelId,
          outboundTo: parsed.to,
          allKnownPeerIds: session.connectorContext?.allKnownPeerIds,
        })
        if (!isCurrentChannel) continue
        noteCurrentChannelDelivery({
          mode: parsed.status === 'voice_sent' ? 'voice_note' : 'text',
          messageId: parsed.messageId,
          transcript: visibleConnectorToolText(parseConnectorToolInput(event.input || '')),
        })
      }
      // Use finalResponse for connectors — strips intermediate planning/tool-use text
      fullText = result.finalResponse || result.fullText
      mediaExtractionText = [result.fullText || '', ...toolMediaOutputs].filter(Boolean).join('\n\n')
      log.info(TAG, `streamAgentChat returned ${result.fullText.length} chars total, ${fullText.length} chars final`)
    } catch (err: unknown) {
      const message = errorMessage(err)
      log.error(TAG, 'streamAgentChat error:', message)
      return `[Error] ${message}`
    }
  } else {
    // Use the provider directly
    const { getProvider } = await import('../../providers')
    const provider = getProvider(session.provider)
    if (!provider) return '[Error] Provider not found.'

    await provider.handler.streamChat({
      session: session as Session,
      message: modelInputText,
      imagePath: firstImagePath,
      apiKey,
      systemPrompt,
      write: (data: string) => {
        if (data.startsWith('data: ')) {
          try {
            const event = JSON.parse(data.slice(6))
            if (event.t === 'd') fullText += event.text || ''
            else if (event.t === 'r') fullText = event.text || ''
          } catch { /* ignore */ }
        }
      },
      active: new Map(),
      loadHistory: () => modelHistoryTailWithAttribution(getMessages(session.id), 50, 48_000),
    })
    mediaExtractionText = fullText
  }

  if (!fullText.trim() && !currentChannelDeliveryRef.current) {
    fullText = connectorEmptyReplyFallback(streamErrorText)
  }

  const suppressHiddenResponse = shouldSuppressHiddenControlText(fullText)
  fullText = stripHiddenControlTokens(fullText)
  fullText = reconcileConnectorDeliveryText(fullText, settledConnectorToolEvents).trim()

  // If the agent chose NO_MESSAGE, skip saving it to history — the user's message
  // is already recorded, and saving the sentinel would pollute the LLM's context
  if (suppressHiddenResponse || isNoMessage(fullText)) {
    if (currentChannelDeliveryRef.current) {
      persistConnectorDeliveryMarker({
        session,
        connector,
        msg,
        delivery: currentChannelDeliveryRef.current,
      })
      await maybeSendStatusReaction(connector, msg, 'sent')
    } else {
      await maybeSendStatusReaction(connector, msg, 'silent')
    }
    log.info(TAG, 'Agent returned hidden control sentinel — suppressing outbound reply')
    logExecution(session.id, 'decision', 'Agent suppressed outbound (NO_MESSAGE)', {
      agentId: agent.id,
      detail: { platform: msg.platform, channelId: msg.channelId },
    })
    return NO_MESSAGE_SENTINEL
  }

  // Log outbound message
  const deliveryPreview = currentChannelDeliveryRef.current
    ? dedup(currentChannelDeliveryRef.current.transcripts.map((entry) => entry.trim()).filter(Boolean)).join('\n\n') || fullText
    : fullText
  logExecution(session.id, 'outbound', `Reply sent via ${msg.platform}`, {
    agentId: agent.id,
    detail: {
      platform: msg.platform,
      channelId: msg.channelId,
      recipientName: msg.senderName,
      responsePreview: deliveryPreview.slice(0, 500),
      responseLength: deliveryPreview.length,
    },
  })

  // Extract embedded media (screenshots, uploaded files) and send them as separate
  // media messages via the connector, then return the cleaned text
  const extractedFromReply = extractEmbeddedMedia(fullText)
  const extractedFromTools = mediaExtractionText && mediaExtractionText !== fullText
    ? extractEmbeddedMedia(mediaExtractionText)
    : { cleanText: mediaExtractionText || fullText, files: [] as Array<{ path: string; alt: string }> }
  const filesToSend = selectOutboundMediaFiles(
    [...extractedFromReply.files, ...extractedFromTools.files],
    msg.text || '',
  )

  if (filesToSend.length > 0) {
    const inst = running.get(connector.id)
    if (inst?.sendMessage) {
      const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound: msg })
      const { sendConnectorMessage } = await import('./connector-outbound')
      for (const file of filesToSend) {
        try {
          await sendConnectorMessage({
            connectorId: connector.id,
            channelId: msg.channelId,
            text: '',
            sessionId: session.id,
            mediaPath: file.path,
            caption: file.alt || undefined,
            replyToMessageId: replyOptions.replyToMessageId,
            threadId: replyOptions.threadId,
          })
          log.info(TAG, `Sent media to ${msg.platform}: ${path.basename(file.path)}`)
          logExecution(session.id, 'outbound', 'Connector media sent', {
            agentId: agent.id,
            detail: {
              platform: msg.platform,
              channelId: msg.channelId,
              filePath: file.path,
              fileName: path.basename(file.path),
            },
          })
        } catch (err: unknown) {
          log.error(TAG, `Failed to send media ${path.basename(file.path)}:`, errorMessage(err))
          logExecution(session.id, 'error', 'Connector media send failed', {
            agentId: agent.id,
            detail: {
              platform: msg.platform,
              channelId: msg.channelId,
              filePath: file.path,
              fileName: path.basename(file.path),
              error: errorMessage(err),
            },
          })
        }
      }
    } else {
      logExecution(session.id, 'error', 'Connector media skipped: sendMessage unavailable', {
        agentId: agent.id,
        detail: {
          platform: msg.platform,
          channelId: msg.channelId,
          fileCount: filesToSend.length,
          connectorId: connector.id,
        },
      })
    }
  }
  let outboundText = (filesToSend.length > 0 ? extractedFromReply.cleanText : fullText).trim()

  if (!currentChannelDeliveryRef.current && senderPreferencePolicy.preferredReplyMedium === 'voice_note' && outboundText) {
    if (!connectorCanSendBinaryMedia(connector)) {
      fullText = `I couldn't send a voice note on this channel because the connector doesn't support audio attachments.`
      outboundText = fullText
    } else {
      const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound: msg })
      try {
        const voicePayload = await prepareConnectorVoiceNotePayload({
          voiceText: outboundText,
          sessionAgentId: session.agentId || agent.id,
          contextAgentId: agent.id,
        })
        const { sendConnectorMessage } = await import('./connector-outbound')
        const sent = await sendConnectorMessage({
          connectorId: connector.id,
          channelId: msg.channelId,
          text: '',
          sessionId: session.id,
          mediaPath: voicePayload.mediaPath,
          mimeType: voicePayload.mimeType,
          fileName: voicePayload.fileName,
          replyToMessageId: replyOptions.replyToMessageId,
          threadId: replyOptions.threadId,
          ptt: true,
        })
        noteCurrentChannelDelivery({
          mode: 'voice_note',
          messageId: sent.messageId,
          transcript: outboundText,
        })
      } catch (err: unknown) {
        fullText = `I couldn't send a voice note right now. ${errorMessage(err)}`
        outboundText = fullText
      }
    }
  }

  if (currentChannelDeliveryRef.current) {
    persistConnectorDeliveryMarker({
      session,
      connector,
      msg,
      delivery: currentChannelDeliveryRef.current,
    })
    await maybeSendStatusReaction(connector, msg, 'sent')
    return NO_MESSAGE_SENTINEL
  }

  const assistantSource = buildConnectorAssistantSource({ connector, msg })
  if (fullText) {
    pushSessionMessage(session, 'assistant', fullText, { source: assistantSource })
    persistSessionRecord(session)
    notify(`messages:${session.id}`)
  }

  if (filesToSend.length > 0) return outboundText || '(no response)'
  return fullText || '(no response)'
  } finally {
    const remaining = (activeDirectConnectorSessionCounts.get(session.id) || 1) - 1
    if (remaining > 0) activeDirectConnectorSessionCounts.set(session.id, remaining)
    else activeDirectConnectorSessionCounts.delete(session.id)
    releaseExternalSessionHold()
    stopTyping?.()
  }
}

routeMessageHandlerRef.current = routeMessage

export const routeConnectorMessageForTest = routeMessage
