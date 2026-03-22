import { log } from '@/lib/server/logger'
import {
  loadConnectors,
  loadSession, upsertSession,
} from '../storage'
import { getMessages, replaceMessageAt } from '@/lib/server/messages/message-repository'
import { errorMessage } from '@/lib/shared-utils'
import path from 'path'
import { notify } from '../ws-hub'
import type { Connector, MessageSource } from '@/types'
import type { ConnectorInstance } from './types'
import { isDirectConnectorSession } from './session-kind'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import { isNoMessage } from './message-sentinel'
import {
  connectorSupportsBinaryMedia,
  normalizeWhatsappTarget,
  uploadApiUrlFromPath,
} from './response-media'
import { enqueueConnectorOutbox } from './outbox'
import { connectorRuntimeState, runningConnectors } from './runtime-state'
import { recordHealthEvent, startConnector } from './connector-lifecycle'

const TAG = 'connector-outbound'

const running = runningConnectors
const { recentOutbound } = connectorRuntimeState
const OUTBOUND_DEDUP_TTL_MS = 30_000
const OUTBOUND_DEDUP_PRUNE_TTL_MS = 60_000

function outboundDedupeKey(params: {
  connectorId: string
  channelId: string
  text?: string
  dedupeKey?: string
}): string {
  const explicit = params.dedupeKey?.trim()
  if (explicit) return `${params.connectorId}:${params.channelId}:dedupe:${explicit}`
  return `${params.connectorId}:${params.channelId}:text:${(params.text || '').slice(0, 200).trim()}`
}

function pruneRecentOutbound(now = Date.now()): void {
  for (const [key, ts] of recentOutbound.entries()) {
    if (now - ts > OUTBOUND_DEDUP_PRUNE_TTL_MS) recentOutbound.delete(key)
  }
}

function isDuplicateOutbound(params: {
  connectorId: string
  channelId: string
  text?: string
  dedupeKey?: string
}): boolean {
  const explicit = params.dedupeKey?.trim()
  const trimmedText = (params.text || '').trim()
  if (!explicit && !trimmedText) return false
  const now = Date.now()
  pruneRecentOutbound(now)
  const key = outboundDedupeKey(params)
  const lastSent = recentOutbound.get(key)
  if (lastSent && now - lastSent < OUTBOUND_DEDUP_TTL_MS) return true
  recentOutbound.set(key, now)
  return false
}

/** Register an outbound send in the dedup map without checking for duplicates */
export function registerOutboundSend(connectorId: string, channelId: string, text: string, dedupeKey?: string): void {
  const now = Date.now()
  pruneRecentOutbound(now)
  const key = outboundDedupeKey({ connectorId, channelId, text, dedupeKey })
  recentOutbound.set(key, now)
}

function connectorCanSendBinaryMedia(connector: Connector): boolean {
  const liveInstance = running.get(connector.id)
  if (typeof liveInstance?.supportsBinaryMedia === 'boolean') {
    return liveInstance.supportsBinaryMedia
  }
  return connectorSupportsBinaryMedia(connector.platform)
}

function isRecoverableConnectorSendError(err: unknown): boolean {
  const message = errorMessage(err)
  return /connection closed|not connected|socket closed|connection terminated|stream errored|connector .* is not running/i.test(message)
}

export function sanitizeConnectorOutboundContent(params: {
  text?: string
  caption?: string
}): {
  sanitizedText: string
  suppressHiddenText: boolean
  sanitizedCaptionText: string
  sanitizedCaption?: string
} {
  const sanitizedText = stripHiddenControlTokens(params.text || '')
  const suppressHiddenText = shouldSuppressHiddenControlText(params.text || '')
  const sanitizedCaptionText = stripHiddenControlTokens(params.caption || '').trim()
  const sanitizedCaption = shouldSuppressHiddenControlText(params.caption || '')
    ? undefined
    : (sanitizedCaptionText || undefined)

  return {
    sanitizedText,
    suppressHiddenText,
    sanitizedCaptionText,
    sanitizedCaption,
  }
}

/**
 * Send an outbound message through a running connector.
 * Intended for proactive agent notifications (e.g. WhatsApp updates).
 */
export async function sendConnectorMessage(params: {
  connectorId?: string
  platform?: string
  channelId: string
  text: string
  dedupeKey?: string
  sessionId?: string | null
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  ptt?: boolean
}): Promise<{ connectorId: string; platform: string; channelId: string; messageId?: string; suppressed?: boolean }> {
  const connectors = loadConnectors()
  const requestedId = params.connectorId?.trim()
  let connector: Connector | undefined
  let connectorId: string | undefined

  if (requestedId) {
    connector = connectors[requestedId] as Connector | undefined
    connectorId = requestedId
    if (!connector) throw new Error(`Connector not found: ${requestedId}`)
  } else {
    const candidates = Object.values(connectors) as Connector[]
    const filtered = candidates.filter((c) => {
      if (params.platform && c.platform !== params.platform) return false
      return running.has(c.id)
    })
    if (!filtered.length) {
      throw new Error(`No running connector found${params.platform ? ` for platform "${params.platform}"` : ''}.`)
    }
    connector = filtered[0]
    connectorId = connector.id
  }

  if (!connector || !connectorId) throw new Error('Connector resolution failed.')

  const {
    sanitizedText,
    suppressHiddenText,
    sanitizedCaptionText,
    sanitizedCaption,
  } = sanitizeConnectorOutboundContent({
    text: params.text,
    caption: params.caption,
  })

  // Apply NO_MESSAGE filter at the delivery layer so all outbound paths respect it
  if ((suppressHiddenText || isNoMessage(sanitizedText)) && !params.imageUrl && !params.fileUrl && !params.mediaPath) {
    log.info(TAG, 'sendConnectorMessage: NO_MESSAGE — suppressing outbound send')
    return { connectorId, platform: connector.platform, channelId: params.channelId, suppressed: true }
  }

  const hasMedia = !!(params.imageUrl || params.fileUrl || params.mediaPath)
  const channelId = connector.platform === 'whatsapp'
    ? normalizeWhatsappTarget(params.channelId)
    : params.channelId

  // Outbound deduplication: skip if identical text was sent to the same channel recently
  // Must run AFTER WhatsApp channel normalization so dedup keys are consistent
  if (isDuplicateOutbound({
    connectorId,
    channelId,
    text: sanitizedText,
    dedupeKey: params.dedupeKey,
  })) {
    log.info(TAG, `sendConnectorMessage: duplicate suppressed for ${connectorId}:${channelId}`)
    return { connectorId, platform: connector.platform, channelId, suppressed: true }
  }

  let outboundText = sanitizedText
  let outboundOptions: Parameters<NonNullable<ConnectorInstance['sendMessage']>>[2] | undefined = {
    imageUrl: params.imageUrl,
    fileUrl: params.fileUrl,
    mediaPath: params.mediaPath,
    mimeType: params.mimeType,
    fileName: params.fileName,
    caption: sanitizedCaption,
    replyToMessageId: params.replyToMessageId,
    threadId: params.threadId,
    ptt: params.ptt,
  }

  if (hasMedia && !connectorCanSendBinaryMedia(connector)) {
    const mediaLink = params.imageUrl
      || params.fileUrl
      || (params.mediaPath ? uploadApiUrlFromPath(params.mediaPath) : null)
    const fallbackParts = [
      sanitizedText.trim(),
      sanitizedCaptionText,
      mediaLink ? `Attachment: ${mediaLink}` : '',
      !mediaLink && params.mediaPath ? `Attachment: ${path.basename(params.mediaPath)}` : '',
    ].filter(Boolean)
    outboundText = fallbackParts.join('\n')
    outboundOptions = undefined
  }

  const sendThroughCurrentInstance = async () => {
    const liveInstance = running.get(connectorId)
    if (!liveInstance) {
      throw new Error(`Connector "${connectorId}" is not running.`)
    }
    if (typeof liveInstance.sendMessage !== 'function') {
      throw new Error(`Connector "${connector.name}" (${connector.platform}) does not support outbound sends.`)
    }
    return liveInstance.sendMessage(channelId, outboundText, outboundOptions)
  }

  let result
  try {
    result = await sendThroughCurrentInstance()
  } catch (err: unknown) {
    if (!isRecoverableConnectorSendError(err)) throw err
    const errMsg = errorMessage(err)
    log.warn(TAG, `Outbound send failed for ${connectorId}; attempting automatic restart`, { error: errMsg })
    recordHealthEvent(connectorId, 'disconnected', `Outbound send failed: ${errMsg}`)
    await startConnector(connectorId)
    result = await sendThroughCurrentInstance()
  }

  if (params.sessionId) {
    const session = loadSession(params.sessionId)
    if (session && isDirectConnectorSession(session)) {
      session.connectorContext = {
        ...(session.connectorContext || {}),
        connectorId,
        platform: connector.platform,
        channelId,
        threadId: params.threadId || session.connectorContext?.threadId || null,
        lastOutboundAt: Date.now(),
        lastOutboundMessageId: result?.messageId || session.connectorContext?.lastOutboundMessageId || null,
      }
      const history = getMessages(session.id)
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i]
        if (entry?.role !== 'assistant') continue
        const source: Partial<MessageSource> = entry?.source || {}
        if (source.connectorId !== connectorId) continue
        if (source.channelId !== channelId) continue
        if (!source.messageId && result?.messageId) {
          const updatedEntry = {
            ...entry,
            source: {
              platform: source.platform || connector.platform,
              connectorId: source.connectorId || connectorId,
              connectorName: source.connectorName || connector.name,
              channelId: source.channelId || channelId,
              senderId: source.senderId,
              senderName: source.senderName,
              messageId: result.messageId,
              threadId: source.threadId || params.threadId,
              replyToMessageId: source.replyToMessageId || params.replyToMessageId,
            },
          }
          replaceMessageAt(session.id, i, updatedEntry)
        }
        break
      }
      upsertSession(session.id, session)
      notify('sessions')
      notify(`messages:${session.id}`)
    }
  }
  return {
    connectorId,
    platform: connector.platform,
    channelId,
    messageId: result?.messageId,
    suppressed: false,
  }
}

export async function performConnectorMessageAction(params: {
  connectorId?: string
  platform?: string
  channelId: string
  action: 'react' | 'edit' | 'delete' | 'pin'
  messageId?: string
  emoji?: string
  text?: string
  sessionId?: string | null
  targetMessage?: 'last_inbound' | 'last_outbound'
}): Promise<{ connectorId: string; platform: string; channelId: string; messageId?: string }> {
  const connectors = loadConnectors()
  const requestedId = params.connectorId?.trim()
  let connector: Connector | undefined
  let connectorId: string | undefined

  if (requestedId) {
    connector = connectors[requestedId] as Connector | undefined
    connectorId = requestedId
    if (!connector) throw new Error(`Connector not found: ${requestedId}`)
  } else {
    const candidates = Object.values(connectors) as Connector[]
    const filtered = candidates.filter((item) => (!params.platform || item.platform === params.platform) && running.has(item.id))
    if (!filtered.length) throw new Error(`No running connector found${params.platform ? ` for platform "${params.platform}"` : ''}.`)
    connector = filtered[0]
    connectorId = connector.id
  }

  if (!connector || !connectorId) throw new Error('Connector resolution failed.')
  const instance = running.get(connectorId)
  if (!instance) throw new Error(`Connector "${connectorId}" is not running.`)

  const targetMessageId = (() => {
    if (params.messageId?.trim()) return params.messageId.trim()
    if (!params.sessionId) return ''
    const session = loadSession(params.sessionId)
    if (!session) return ''
    if (params.targetMessage === 'last_inbound') return session.connectorContext?.lastInboundMessageId || ''
    if (params.targetMessage === 'last_outbound' || !params.targetMessage) return session.connectorContext?.lastOutboundMessageId || ''
    return ''
  })()
  if (!targetMessageId) throw new Error('messageId is required for connector message actions.')

  switch (params.action) {
    case 'react':
      if (!instance.sendReaction) throw new Error(`Connector "${connector.name}" does not support reactions.`)
      if (!params.emoji?.trim()) throw new Error('emoji is required for react action.')
      await instance.sendReaction(params.channelId, targetMessageId, params.emoji.trim())
      break
    case 'edit':
      if (!instance.editMessage) throw new Error(`Connector "${connector.name}" does not support edits.`)
      if (!params.text?.trim()) throw new Error('text is required for edit action.')
      await instance.editMessage(params.channelId, targetMessageId, params.text.trim())
      break
    case 'delete':
      if (!instance.deleteMessage) throw new Error(`Connector "${connector.name}" does not support deletes.`)
      await instance.deleteMessage(params.channelId, targetMessageId)
      break
    case 'pin':
      if (!instance.pinMessage) throw new Error(`Connector "${connector.name}" does not support pinning.`)
      await instance.pinMessage(params.channelId, targetMessageId)
      break
  }

  return {
    connectorId,
    platform: connector.platform,
    channelId: params.channelId,
    messageId: targetMessageId,
  }
}

export function scheduleConnectorFollowUp(params: {
  connectorId?: string
  platform?: string
  channelId: string
  text: string
  delaySec?: number
  dedupeKey?: string
  replaceExisting?: boolean
  sessionId?: string | null
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  ptt?: boolean
}): { followUpId: string; sendAt: number } {
  const delaySecRaw = Number.isFinite(params.delaySec) ? Number(params.delaySec) : 300
  const delayMs = Math.max(1_000, Math.min(86_400_000, Math.round(delaySecRaw * 1000)))
  const dedupeKey = params.dedupeKey || [
    params.connectorId || params.platform || '',
    params.channelId,
    params.threadId || '',
    (params.text || '').trim().slice(0, 160),
  ].join('|')
  const { outboxId, sendAt } = enqueueConnectorOutbox({
    connectorId: params.connectorId,
    platform: params.platform,
    channelId: params.channelId,
    text: params.text,
    sessionId: params.sessionId,
    imageUrl: params.imageUrl,
    fileUrl: params.fileUrl,
    mediaPath: params.mediaPath,
    mimeType: params.mimeType,
    fileName: params.fileName,
    caption: params.caption,
    replyToMessageId: params.replyToMessageId,
    threadId: params.threadId,
    ptt: params.ptt,
    sendAt: Date.now() + delayMs,
    dedupeKey,
  }, {
    replaceExisting: params.replaceExisting,
  })

  return { followUpId: outboxId, sendAt }
}
