import type { Connector, MessageSource } from '@/types'
import { loadConnectors } from './connector-repository'
import { getMessages, replaceMessageAt } from '@/lib/server/messages/message-repository'
import { notify } from '../ws-hub'
import { resolveConnectorSessionPolicy, shouldReplyToInboundMessage } from './policy'
import { runningConnectors } from './runtime-state'
import { findDirectSessionForInbound, persistSessionRecord } from './session'
import type { InboundMessage } from './types'

export function getConnectorReplySendOptions(params: {
  connectorId: string
  inbound: InboundMessage
}): { replyToMessageId?: string; threadId?: string } {
  const connectors = loadConnectors()
  const connector = connectors[params.connectorId] as Connector | undefined
  if (!connector) return {}
  const session = findDirectSessionForInbound(connector, params.inbound)
  const policy = resolveConnectorSessionPolicy(connector, params.inbound, session)
  return shouldReplyToInboundMessage({
    msg: params.inbound,
    session,
    policy,
  })
}

export function statusReactionForPlatform(platform: string, state: 'processing' | 'sent' | 'silent'): string {
  if (platform === 'slack') {
    if (state === 'processing') return 'eyes'
    if (state === 'sent') return 'white_check_mark'
    return 'zipper_mouth_face'
  }
  if (state === 'processing') return '👀'
  if (state === 'sent') return '✅'
  return '🤐'
}

export async function maybeSendStatusReaction(
  connector: Connector,
  msg: InboundMessage,
  state: 'processing' | 'sent' | 'silent',
): Promise<void> {
  if (!msg.messageId) return
  const session = findDirectSessionForInbound(connector, msg)
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (!policy.statusReactions) return
  const instance = runningConnectors.get(connector.id)
  if (!instance?.sendReaction) return
  try {
    await instance.sendReaction(msg.channelId, msg.messageId, statusReactionForPlatform(connector.platform, state))
  } catch {
    // Status reactions are best-effort only.
  }
}

export async function recordConnectorOutboundDelivery(params: {
  connectorId: string
  inbound: InboundMessage
  messageId?: string
  state?: 'sent' | 'silent'
}): Promise<void> {
  const connectors = loadConnectors()
  const connector = connectors[params.connectorId] as Connector | undefined
  if (!connector) return
  const session = findDirectSessionForInbound(connector, params.inbound)
  if (session) {
    session.connectorContext = {
      ...(session.connectorContext || {}),
      lastOutboundAt: Date.now(),
      lastOutboundMessageId: params.messageId || session.connectorContext?.lastOutboundMessageId || null,
      threadId: params.inbound.threadId || session.connectorContext?.threadId || null,
    }
    const history = getMessages(session.id)
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const entry = history[i]
      if (entry?.role !== 'assistant') continue
      const source: Partial<MessageSource> = entry?.source || {}
      if (source.connectorId !== connector.id) continue
      if (source.channelId !== params.inbound.channelId) continue
      if (!source.messageId && params.messageId) {
        const updatedEntry = {
          ...entry,
          source: {
            platform: source.platform || connector.platform,
            connectorId: source.connectorId || connector.id,
            connectorName: source.connectorName || connector.name,
            channelId: source.channelId || params.inbound.channelId,
            senderId: source.senderId,
            senderName: source.senderName,
            messageId: params.messageId,
            replyToMessageId: source.replyToMessageId || params.inbound.messageId,
            threadId: source.threadId || params.inbound.threadId,
          },
        }
        replaceMessageAt(session.id, i, updatedEntry)
      }
      break
    }
    persistSessionRecord(session)
    notify(`messages:${session.id}`)
  }
  if (params.state) {
    await maybeSendStatusReaction(connector, params.inbound, params.state)
  }
}

export function splitConnectorText(text: string, maxChunkLength: number): string[] {
  if (!text) return ['']
  if (text.length <= maxChunkLength) return [text]
  return text.match(new RegExp(`[\\s\\S]{1,${Math.max(1, maxChunkLength)}}`, 'g')) || [text]
}

export async function deliverChunkedConnectorText(params: {
  connectorId: string
  inbound: InboundMessage
  text: string
  maxSingleMessageLength: number
  chunkLength: number
  sendChunk: (
    chunk: string,
    meta: { isFirstChunk: boolean; replyToMessageId?: string; threadId?: string },
  ) => Promise<string | undefined>
}): Promise<string | undefined> {
  const replyOptions = getConnectorReplySendOptions({
    connectorId: params.connectorId,
    inbound: params.inbound,
  })
  const chunks = params.text.length <= params.maxSingleMessageLength
    ? [params.text]
    : splitConnectorText(params.text, params.chunkLength)

  let lastMessageId: string | undefined
  for (let index = 0; index < chunks.length; index += 1) {
    lastMessageId = await params.sendChunk(chunks[index], {
      isFirstChunk: index === 0,
      replyToMessageId: replyOptions.replyToMessageId,
      threadId: replyOptions.threadId,
    })
  }

  await recordConnectorOutboundDelivery({
    connectorId: params.connectorId,
    inbound: params.inbound,
    messageId: lastMessageId,
    state: 'sent',
  })
  return lastMessageId
}
