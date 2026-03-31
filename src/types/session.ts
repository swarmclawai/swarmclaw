import type { ProviderId, OllamaMode } from './provider'
import type { ConnectorPlatform } from './connector'
import type { Message } from './message'

export type SessionResetMode = 'idle' | 'daily' | 'isolated'
export type SessionResetType = 'direct' | 'group' | 'thread' | 'main'

export interface IdentityContinuityState {
  selfSummary?: string | null
  relationshipSummary?: string | null
  personaLabel?: string | null
  toneStyle?: string | null
  boundaries?: string[]
  continuityNotes?: string[]
  updatedAt?: number | null
}

export interface SessionArchiveState {
  memoryId?: string | null
  lastSyncedAt?: number | null
  lastHash?: string | null
  messageCount?: number
  exportPath?: string | null
}

export interface SessionSkillRuntimeState {
  selectedSkillId?: string | null
  selectedSkillName?: string | null
  selectedAt?: number | null
  lastAction?: 'select' | 'load' | 'run' | null
  lastRunAt?: number | null
  lastRunToolName?: string | null
}


export interface MailboxEnvelope {
  id: string
  type: string
  payload: string
  fromSessionId?: string | null
  fromAgentId?: string | null
  toSessionId: string
  toAgentId?: string | null
  correlationId?: string | null
  status: MailboxStatus
  createdAt: number
  expiresAt?: number | null
  ackAt?: number | null
}

export type MailboxStatus = 'new' | 'ack'

export interface Session {
  id: string
  name: string
  openclawAgentId?: string | null
  shortcutForAgentId?: string | null
  cwd: string
  user: string
  provider: ProviderId
  model: string
  ollamaMode?: OllamaMode | null
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  routePreferredGatewayTags?: string[]
  routePreferredGatewayUseCase?: string | null
  claudeSessionId: string | null
  codexThreadId?: string | null
  opencodeSessionId?: string | null
  geminiSessionId?: string | null
  copilotSessionId?: string | null
  delegateResumeIds?: {
    claudeCode?: string | null
    codex?: string | null
    opencode?: string | null
    gemini?: string | null
    copilot?: string | null
  }
  /** @deprecated Messages are stored in session_messages table. Use message-repository. */
  messages: Message[]
  /** Pre-computed message count (kept in sync by message-repository). */
  messageCount?: number
  lastMessageSummary?: Message | null
  lastAssistantAt?: number | null
  createdAt: number
  updatedAt?: number | null
  lastActiveAt: number
  active?: boolean
  sessionType?: SessionType
  agentId?: string | null
  parentSessionId?: string | null
  delegationDepth?: number | null
  tools?: string[]
  extensions?: string[]
  heartbeatEnabled?: boolean | null
  heartbeatIntervalSec?: number | null
  heartbeatTarget?: 'last' | 'none' | string | null
  memoryScopeMode?: 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project' | null
  memoryTierPreference?: 'working' | 'durable' | 'archive' | 'blended' | null
  projectId?: string | null
  sessionResetMode?: SessionResetMode | null
  sessionIdleTimeoutSec?: number | null
  sessionMaxAgeSec?: number | null
  sessionDailyResetAt?: string | null
  sessionResetTimezone?: string | null
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | null
  browserProfileId?: string | null
  connectorThinkLevel?: 'minimal' | 'low' | 'medium' | 'high' | null
  connectorSessionScope?: 'main' | 'channel' | 'peer' | 'channel-peer' | 'thread' | null
  connectorReplyMode?: 'off' | 'first' | 'all' | null
  connectorThreadBinding?: 'off' | 'prefer' | 'strict' | null
  connectorGroupPolicy?: 'open' | 'mention' | 'reply-or-mention' | 'disabled' | null
  connectorIdleTimeoutSec?: number | null
  connectorMaxAgeSec?: number | null
  /** Last heartbeat/cron delivery status */
  lastDeliveryStatus?: 'ok' | 'error' | null
  /** Timestamp of last heartbeat/cron delivery attempt */
  lastDeliveredAt?: number | null
  /** Error message from last failed delivery */
  lastDeliveryError?: string | null
  mailbox?: MailboxEnvelope[] | null
  connectorContext?: {
    connectorId?: string | null
    platform?: ConnectorPlatform | null
    channelId?: string | null
    channelIdAlt?: string | null
    senderId?: string | null
    senderIdAlt?: string | null
    senderName?: string | null
    senderAvatarUrl?: string | null
    sessionKey?: string | null
    peerKey?: string | null
    scope?: 'main' | 'channel' | 'peer' | 'channel-peer' | 'thread' | null
    replyMode?: 'off' | 'first' | 'all' | null
    threadBinding?: 'off' | 'prefer' | 'strict' | null
    groupPolicy?: 'open' | 'mention' | 'reply-or-mention' | 'disabled' | null
    threadId?: string | null
    threadTitle?: string | null
    threadPersonaLabel?: string | null
    threadParentChannelId?: string | null
    threadParentChannelName?: string | null
    isGroup?: boolean
    isOwnerConversation?: boolean
    lastInboundAt?: number | null
    lastInboundMessageId?: string | null
    lastInboundReplyToMessageId?: string | null
    lastInboundThreadId?: string | null
    lastOutboundAt?: number | null
    lastOutboundMessageId?: string | null
    lastResetAt?: number | null
    lastResetReason?: string | null
    allKnownPeerIds?: string[] | null
  }
  lastAutoMemoryAt?: number | null
  lastHeartbeatText?: string | null
  lastHeartbeatSentAt?: number | null
  lastSessionResetAt?: number | null
  lastSessionResetReason?: string | null
  identityState?: IdentityContinuityState | null
  sessionArchiveState?: SessionArchiveState | null
  skillRuntimeState?: SessionSkillRuntimeState | null
  pinned?: boolean
  file?: string | null
  queuedCount?: number
  currentRunId?: string | null
  conversationTone?: string
  emoji?: string
  creature?: string
  vibe?: string
  theme?: string
  avatar?: string
  /** Tracks how many times each memory ID has been injected via proactive recall in this session. */
  injectedMemoryIds?: Record<string, number>
  /** Structured working memory that survives compaction and flows through delegation. */
  runContext?: RunContext | null
}

export interface RunContext {
  objective: string | null
  constraints: string[]
  keyFacts: string[]
  discoveries: string[]
  failedApproaches: string[]
  currentPlan: string[]
  completedSteps: string[]
  blockers: string[]
  parentContext: string | null
  updatedAt: number
  version: number
}

export type Sessions = Record<string, Session>

export type SessionTool =
  | 'shell'
  | 'files'
  | 'claude_code'
  | 'codex_cli'
  | 'opencode_cli'
  | 'web_search'
  | 'web_fetch'
  | 'edit_file'
  | 'process'
  | 'spawn_subagent'
  | 'http_request'
  | 'git'
  | 'mailbox'
  | 'ask_human'
  | 'document'
  | 'extract'
  | 'table'
  | 'crawl'

export type SessionType = 'human'
export type AppView = 'home' | 'agents' | 'org_chart' | 'inbox' | 'chatrooms' | 'protocols' | 'schedules' | 'memory' | 'tasks' | 'secrets' | 'wallets' | 'providers' | 'skills' | 'connectors' | 'webhooks' | 'mcp_servers' | 'knowledge' | 'extensions' | 'usage' | 'runs' | 'autonomy' | 'logs' | 'settings' | 'projects' | 'activity'
