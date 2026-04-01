import type { WhatsAppApprovedContact } from './app-settings'

// --- Connector Health Events ---

export type ConnectorHealthEventType = 'started' | 'stopped' | 'error' | 'reconnected' | 'disconnected'

export interface ConnectorHealthEvent {
  id: string
  connectorId: string
  event: ConnectorHealthEventType
  message?: string
  timestamp: string
}

// --- Connectors (Chat Platform Bridges) ---

export type ConnectorPlatform =
  | 'discord'
  | 'telegram'
  | 'slack'
  | 'whatsapp'
  | 'openclaw'
  | 'bluebubbles'
  | 'signal'
  | 'teams'
  | 'googlechat'
  | 'matrix'
  | 'email'
  | 'webchat'
  | 'mockmail'
  | 'swarmdock'
export type ConnectorStatus = 'stopped' | 'running' | 'error' | 'starting'

export interface MessageSource {
  platform: ConnectorPlatform
  connectorId: string
  connectorName: string
  channelId?: string
  senderId?: string
  senderName?: string
  messageId?: string
  replyToMessageId?: string
  threadId?: string
  deliveryMode?: 'text' | 'voice_note'
  deliveryTranscript?: string | null
}

export interface Connector {
  id: string
  name: string
  platform: ConnectorPlatform
  agentId?: string | null        // which agent handles incoming messages (optional if using chatroomId)
  chatroomId?: string | null     // route to a chatroom instead of a single agent
  credentialId?: string | null    // bot token stored as encrypted credential
  config: Record<string, string>  // platform-specific settings
  isEnabled: boolean
  status: ConnectorStatus
  lastError?: string | null
  /** WhatsApp QR code data URL (runtime only) */
  qrDataUrl?: string | null
  /** WhatsApp authenticated/paired state (runtime only) */
  authenticated?: boolean
  /** WhatsApp has stored credentials from previous pairing (runtime only) */
  hasCredentials?: boolean
  /** Connector presence info (runtime only) */
  presence?: { lastMessageAt?: number | null; channelId?: string | null }
  createdAt: number
  updatedAt: number
}

export type ConnectorDmAddressingMode = 'open' | 'addressed'

export interface ConnectorAccessSenderStatus {
  senderIds: string[]
  isOwnerOverride: boolean
  isBlocked: boolean
  isApproved: boolean
  isConfigAllowed: boolean
  isStoredAllowed: boolean
  isGlobalAllowed: boolean
  isPending: boolean
  pendingCode?: string | null
  dmAddressingOverride: ConnectorDmAddressingMode | null
  effectiveDmAddressingMode: ConnectorDmAddressingMode
  requiresDirectAddress: boolean
}

export interface ConnectorAccessSnapshot {
  connectorId: string
  platform: ConnectorPlatform
  dmPolicy: 'open' | 'allowlist' | 'pairing' | 'disabled'
  dmAddressingMode: ConnectorDmAddressingMode
  allowFrom: string[]
  denyFrom: string[]
  ownerSenderId: string | null
  storedAllowedSenderIds: string[]
  senderAddressingOverrides: Array<{
    senderId: string
    dmAddressingMode: ConnectorDmAddressingMode
  }>
  pendingPairingRequests: Array<{
    code: string
    senderId: string
    senderName?: string
    channelId?: string
    createdAt: number
    updatedAt: number
  }>
  globalWhatsAppApprovedContacts: WhatsAppApprovedContact[]
  senderStatus?: ConnectorAccessSenderStatus | null
}

export type ConnectorAccessMutationAction =
  | 'set_policy'
  | 'set_dm_addressing_mode'
  | 'allow_sender'
  | 'remove_allowed_sender'
  | 'block_sender'
  | 'unblock_sender'
  | 'approve_pairing'
  | 'reject_pairing'
  | 'set_owner'
  | 'clear_owner'
  | 'set_sender_dm_addressing'
  | 'clear_sender_dm_addressing'

export interface ConnectorAccessMutationResponse {
  ok: boolean
  snapshot: ConnectorAccessSnapshot
}

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
  url?: string
  localPath?: string
}

export interface InboundMessage {
  platform: string
  channelId: string
  channelIdAlt?: string
  channelName?: string
  senderId: string
  senderIdAlt?: string
  senderName: string
  senderAvatarUrl?: string
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
  isOwnerConversation?: boolean
}

export interface OutboundSendOptions {
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  ptt?: boolean
  replyToMessageId?: string
  threadId?: string
}
