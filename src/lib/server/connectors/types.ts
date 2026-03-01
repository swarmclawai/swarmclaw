import type { Connector } from '@/types'

export type InboundMediaType = 'image' | 'video' | 'audio' | 'document' | 'file'

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
  channelName?: string     // human-readable name
  senderId: string         // platform-specific user ID
  senderName: string       // display name
  text: string
  isGroup?: boolean
  imageUrl?: string
  media?: InboundMedia[]
  replyToMessageId?: string
  agentIdOverride?: string
}

/** A running connector instance */
export interface ConnectorInstance {
  connector: Connector
  stop: () => Promise<void>
  /** Optional outbound send support for proactive agent notifications */
  sendMessage?: (
    channelId: string,
    text: string,
    options?: {
      imageUrl?: string
      fileUrl?: string
      /** Absolute local file path (e.g. screenshot saved to disk) */
      mediaPath?: string
      mimeType?: string
      fileName?: string
      caption?: string
    },
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
}

/** Platform-specific connector implementation */
export interface PlatformConnector {
  start(
    connector: Connector,
    botToken: string,
    onMessage: (msg: InboundMessage) => Promise<string>,
  ): Promise<ConnectorInstance>
}
