import type { Connector } from '@/types'

export type InboundMediaType = 'image' | 'video' | 'audio' | 'document' | 'file'

export interface InboundThreadHistoryEntry {
  role: 'user' | 'assistant'
  senderName: string
  text: string
  messageId?: string
}

export interface InboundMedia {
  type: InboundMediaType
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  /** Public URL when available (typically /api/uploads/...) */
  url?: string
  /** Absolute local path where media was persisted, if stored */
  localPath?: string
}

/** Inbound message from a chat platform */
export interface InboundMessage {
  platform: string
  channelId: string        // platform-specific channel/chat ID
  channelIdAlt?: string
  channelName?: string     // human-readable name
  senderId: string         // platform-specific user ID
  senderIdAlt?: string
  senderName: string       // display name
  text: string
  isGroup?: boolean
  messageId?: string
  imageUrl?: string
  media?: InboundMedia[]
  replyToMessageId?: string
  threadId?: string
  threadTitle?: string
  threadStarterText?: string
  threadStarterSenderName?: string
  threadPersonaLabel?: string
  threadParentChannelId?: string
  threadParentChannelName?: string
  threadHistory?: InboundThreadHistoryEntry[]
  mentionsBot?: boolean
  agentIdOverride?: string
}

export interface OutboundSendOptions {
  imageUrl?: string
  fileUrl?: string
  /** Absolute local file path (e.g. screenshot saved to disk) */
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  /** Send audio as a WhatsApp voice note (push-to-talk) */
  ptt?: boolean
  /** Platform-native reply target when supported */
  replyToMessageId?: string
  /** Platform-native thread or topic identifier when supported */
  threadId?: string
}

export interface OutboundTypingOptions {
  /** Platform-native thread or topic identifier when supported */
  threadId?: string
}

export interface ConnectorRouteResult {
  managerHandled: boolean
  visibleText: string
  delivery: 'sent' | 'silent'
  messageId?: string
}

export type ConnectorIngressResult = string | ConnectorRouteResult

export function isConnectorRouteResult(value: unknown): value is ConnectorRouteResult {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as ConnectorRouteResult).managerHandled === 'boolean'
    && typeof (value as ConnectorRouteResult).visibleText === 'string'
}

export function normalizeConnectorIngressResult(value: ConnectorIngressResult): ConnectorRouteResult {
  if (isConnectorRouteResult(value)) return value
  const visibleText = typeof value === 'string' ? value : ''
  const normalized = visibleText.trim().toUpperCase()
  return {
    managerHandled: false,
    visibleText,
    delivery: normalized && normalized !== 'NO_MESSAGE' ? 'sent' : 'silent',
  }
}

/** A running connector instance */
export interface ConnectorInstance {
  connector: Connector
  stop: () => Promise<void>
  /** Optional outbound send support for proactive agent notifications */
  sendMessage?: (
    channelId: string,
    text: string,
    options?: OutboundSendOptions,
  ) => Promise<{ messageId?: string } | void>
  /** Current QR code data URL (WhatsApp only, null when paired) */
  qrDataUrl?: string | null
  /** Whether the connector has successfully authenticated (WhatsApp only) */
  authenticated?: boolean
  /** Whether the connector has existing saved credentials (WhatsApp only) */
  hasCredentials?: boolean
  /** Rich messaging: send a reaction emoji to a message */
  sendReaction?: (channelId: string, messageId: string, emoji: string) => Promise<void>
  /** Rich messaging: edit a previously sent message */
  editMessage?: (channelId: string, messageId: string, newText: string) => Promise<void>
  /** Rich messaging: delete a message */
  deleteMessage?: (channelId: string, messageId: string) => Promise<void>
  /** Rich messaging: pin a message */
  pinMessage?: (channelId: string, messageId: string) => Promise<void>
  /** Best-effort typing or "working" indicator for the target conversation */
  sendTyping?: (channelId: string, options?: OutboundTypingOptions) => Promise<void>
  /** Health check: returns true if the underlying connection is alive */
  isAlive?: () => boolean
  /** Called by the platform when the connection dies terminally (no internal retry) */
  onCrash?: (error: string) => void
}

/** Platform-specific connector implementation */
export interface PlatformConnector {
  start(
    connector: Connector,
    botToken: string,
    onMessage: (msg: InboundMessage) => Promise<ConnectorIngressResult>,
  ): Promise<ConnectorInstance>
}
