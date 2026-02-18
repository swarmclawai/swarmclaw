import type { Connector } from '@/types'

/** Inbound message from a chat platform */
export interface InboundMessage {
  platform: string
  channelId: string        // platform-specific channel/chat ID
  channelName?: string     // human-readable name
  senderId: string         // platform-specific user ID
  senderName: string       // display name
  text: string
  imageUrl?: string
  replyToMessageId?: string
}

/** A running connector instance */
export interface ConnectorInstance {
  connector: Connector
  stop: () => Promise<void>
  /** Current QR code data URL (WhatsApp only, null when paired) */
  qrDataUrl?: string | null
}

/** Platform-specific connector implementation */
export interface PlatformConnector {
  start(
    connector: Connector,
    botToken: string,
    onMessage: (msg: InboundMessage) => Promise<string>,
  ): Promise<ConnectorInstance>
}
