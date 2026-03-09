import type { Connector, Session, SessionResetMode, SessionResetType } from '@/types'
import { getProvider } from '@/lib/providers'
import type { InboundMessage } from './types'
import { evaluateSessionFreshness, inferSessionResetType, resetSessionRuntime, resolveSessionResetPolicy } from '../session-reset-policy'
import { getWhatsAppApprovedSenderIds, listStoredAllowedSenders, parseAllowFromCsv, parsePairingPolicy } from './pairing'
import { loadAgents, loadChatrooms, loadCredentials, loadSettings } from '../storage'

export type ConnectorSessionScope = 'main' | 'channel' | 'peer' | 'channel-peer' | 'thread'
export type ConnectorReplyMode = 'off' | 'first' | 'all'
export type ConnectorThreadBinding = 'off' | 'prefer' | 'strict'
export type ConnectorGroupPolicy = 'open' | 'mention' | 'reply-or-mention' | 'disabled'
export type ConnectorThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export interface ResolvedConnectorSessionPolicy {
  scope: ConnectorSessionScope
  replyMode: ConnectorReplyMode
  threadBinding: ConnectorThreadBinding
  groupPolicy: ConnectorGroupPolicy
  thinkingLevel: ConnectorThinkingLevel | null
  providerOverride: string | null
  modelOverride: string | null
  resetType: SessionResetType
  resetMode: SessionResetMode
  idleTimeoutSec: number | null
  maxAgeSec: number | null
  dailyResetAt: string | null
  resetTimezone: string | null
  inboundDebounceMs: number
  statusReactions: boolean
  typingIndicators: boolean
}

export interface ConnectorSessionStaleness {
  stale: boolean
  reason?: string
}

const DEFAULT_DM_SCOPE: ConnectorSessionScope = 'channel-peer'
const DEFAULT_GROUP_SCOPE: ConnectorSessionScope = 'channel'
const DEFAULT_REPLY_MODE: ConnectorReplyMode = 'first'
const DEFAULT_THREAD_BINDING: ConnectorThreadBinding = 'prefer'
const DEFAULT_GROUP_POLICY: ConnectorGroupPolicy = 'reply-or-mention'
const DEFAULT_IDLE_TIMEOUT_SEC = 12 * 60 * 60
const DEFAULT_MAX_AGE_SEC = 7 * 24 * 60 * 60
const DEFAULT_INBOUND_DEBOUNCE_MS = 700

function parseIntBounded(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined) return null
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string'
      ? Number.parseInt(raw.trim(), 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function normalizeEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (allowed as readonly string[]).includes(normalized) ? normalized as T : fallback
}

export function normalizeConnectorSessionScope(raw: unknown, fallback: ConnectorSessionScope): ConnectorSessionScope {
  return normalizeEnum(raw, ['main', 'channel', 'peer', 'channel-peer', 'thread'] as const, fallback)
}

export function normalizeConnectorReplyMode(raw: unknown, fallback: ConnectorReplyMode = DEFAULT_REPLY_MODE): ConnectorReplyMode {
  return normalizeEnum(raw, ['off', 'first', 'all'] as const, fallback)
}

export function normalizeConnectorThreadBinding(raw: unknown, fallback: ConnectorThreadBinding = DEFAULT_THREAD_BINDING): ConnectorThreadBinding {
  return normalizeEnum(raw, ['off', 'prefer', 'strict'] as const, fallback)
}

export function normalizeConnectorGroupPolicy(raw: unknown, fallback: ConnectorGroupPolicy = DEFAULT_GROUP_POLICY): ConnectorGroupPolicy {
  return normalizeEnum(raw, ['open', 'mention', 'reply-or-mention', 'disabled'] as const, fallback)
}

export function normalizeConnectorThinkingLevel(raw: unknown, fallback: ConnectorThinkingLevel | null = null): ConnectorThinkingLevel | null {
  if (raw === null || raw === undefined) return fallback
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized
  }
  return fallback
}

function normalizeSessionResetMode(raw: unknown, fallback: SessionResetMode): SessionResetMode {
  return normalizeEnum(raw, ['idle', 'daily'] as const, fallback)
}

function normalizeTimeHHMM(raw: unknown, fallback: string | null): string | null {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return fallback
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function normalizeTimezone(raw: unknown, fallback: string | null): string | null {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  return trimmed || fallback
}

function normalizeNonEmptyText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed || null
}

function normalizeProviderOverride(raw: unknown): string | null {
  const trimmed = normalizeNonEmptyText(raw)
  if (!trimmed) return null
  return getProvider(trimmed) ? trimmed : null
}

export function textMentionsAlias(text: string, aliases: string[]): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  for (const alias of aliases) {
    const trimmed = alias.trim()
    if (!trimmed) continue
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(^|\\s)(@?${escaped})(?=$|[\\s:,.!?])`, 'i')
    if (pattern.test(normalized)) return true
  }
  return false
}

export function resolveConnectorSessionPolicy(
  connector: Connector,
  msg: InboundMessage,
  session?: Partial<Session> | null,
): ResolvedConnectorSessionPolicy {
  const fallbackScope = msg.isGroup ? DEFAULT_GROUP_SCOPE : DEFAULT_DM_SCOPE
  const scope = normalizeConnectorSessionScope(
    session?.connectorSessionScope ?? connector.config?.sessionScope,
    fallbackScope,
  )
  const resetType = inferSessionResetType(session, {
    isGroup: msg.isGroup,
    threadId: msg.threadId || null,
  })
  const baseReset = resolveSessionResetPolicy({ session, resetType })
  return {
    scope,
    replyMode: normalizeConnectorReplyMode(session?.connectorReplyMode ?? connector.config?.replyMode),
    threadBinding: normalizeConnectorThreadBinding(session?.connectorThreadBinding ?? connector.config?.threadBinding),
    groupPolicy: normalizeConnectorGroupPolicy(session?.connectorGroupPolicy ?? connector.config?.groupPolicy),
    thinkingLevel: normalizeConnectorThinkingLevel(session?.connectorThinkLevel ?? connector.config?.thinkingLevel, null),
    providerOverride: normalizeProviderOverride(connector.config?.providerOverride),
    modelOverride: normalizeNonEmptyText(connector.config?.modelOverride),
    resetType,
    resetMode: normalizeSessionResetMode(
      session?.sessionResetMode ?? connector.config?.sessionResetMode,
      baseReset.mode,
    ),
    idleTimeoutSec: parseIntBounded(
      session?.connectorIdleTimeoutSec ?? connector.config?.idleTimeoutSec,
      0,
      30 * 24 * 60 * 60,
    ) ?? baseReset.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC,
    maxAgeSec: parseIntBounded(
      session?.connectorMaxAgeSec ?? connector.config?.maxAgeSec,
      0,
      90 * 24 * 60 * 60,
    ) ?? baseReset.maxAgeSec ?? DEFAULT_MAX_AGE_SEC,
    dailyResetAt: normalizeTimeHHMM(
      session?.sessionDailyResetAt ?? connector.config?.sessionDailyResetAt,
      baseReset.dailyResetAt,
    ),
    resetTimezone: normalizeTimezone(
      session?.sessionResetTimezone ?? connector.config?.sessionResetTimezone,
      baseReset.timezone,
    ),
    inboundDebounceMs: parseIntBounded(
      connector.config?.inboundDebounceMs,
      0,
      60_000,
    ) ?? DEFAULT_INBOUND_DEBOUNCE_MS,
    statusReactions: parseBool(connector.config?.statusReactions, true),
    typingIndicators: parseBool(connector.config?.typingIndicators, true),
  }
}

function normalizeKeyPart(raw: string | null | undefined, fallback = 'none'): string {
  const normalized = (raw || '').trim()
  return normalized || fallback
}

export function buildConnectorConversationKey(params: {
  connector: Connector
  msg: InboundMessage
  agentId: string
  policy: ResolvedConnectorSessionPolicy
}): string {
  const { connector, msg, agentId, policy } = params
  let scope = policy.scope
  if (scope === 'thread' && !msg.threadId) {
    scope = msg.isGroup ? 'channel' : 'channel-peer'
  }
  if (policy.threadBinding === 'strict' && msg.threadId) {
    scope = 'thread'
  }

  const parts = [`connector:${connector.id}`, `agent:${normalizeKeyPart(agentId)}`]
  switch (scope) {
    case 'main':
      parts.push('main')
      break
    case 'channel':
      parts.push(`channel:${normalizeKeyPart(msg.channelId)}`)
      break
    case 'peer':
      parts.push(`peer:${normalizeKeyPart(msg.senderId)}`)
      break
    case 'channel-peer':
      parts.push(`channel:${normalizeKeyPart(msg.channelId)}`, `peer:${normalizeKeyPart(msg.senderId)}`)
      break
    case 'thread':
      parts.push(
        `channel:${normalizeKeyPart(msg.channelId)}`,
        `thread:${normalizeKeyPart(msg.threadId || msg.replyToMessageId || msg.messageId)}`,
      )
      break
  }
  return parts.join(':')
}

export function buildInboundDedupeKey(connector: Connector, msg: InboundMessage): string {
  if (msg.messageId) return `msg:${connector.id}:${normalizeKeyPart(msg.channelId)}:${normalizeKeyPart(msg.messageId)}`
  const rawText = msg.text.trim().replace(/\s+/g, ' ').toLowerCase()
  const textKey = rawText.slice(0, 240) || '(empty)'
  return [
    'text',
    connector.id,
    normalizeKeyPart(msg.channelId),
    normalizeKeyPart(msg.senderId),
    normalizeKeyPart(msg.threadId),
    normalizeKeyPart(msg.replyToMessageId),
    textKey,
  ].join(':')
}

export function buildInboundDebounceKey(connector: Connector, msg: InboundMessage): string {
  return [
    connector.id,
    normalizeKeyPart(msg.channelId),
    normalizeKeyPart(msg.senderId),
    normalizeKeyPart(msg.threadId),
  ].join(':')
}

export function mergeInboundMessages(messages: InboundMessage[]): InboundMessage {
  if (!messages.length) {
    throw new Error('Cannot merge zero inbound messages')
  }
  if (messages.length === 1) return messages[0]

  const last = messages[messages.length - 1]
  const sameSender = messages.every((msg) => msg.senderId === last.senderId)
  const text = messages
    .map((msg) => {
      const content = msg.text.trim()
      if (!content) return ''
      return sameSender ? content : `[${msg.senderName}] ${content}`
    })
    .filter(Boolean)
    .join('\n')
  const media = messages.flatMap((msg) => msg.media || [])
  const imageUrl = messages.map((msg) => msg.imageUrl).find(Boolean)

  return {
    ...last,
    text,
    media: media.length ? media : undefined,
    imageUrl,
  }
}

export function getConnectorSessionStaleness(
  session: Partial<Session> | null | undefined,
  policy: ResolvedConnectorSessionPolicy,
  now = Date.now(),
): ConnectorSessionStaleness {
  const freshness = evaluateSessionFreshness({
    session,
    now,
    policy: {
      type: policy.resetType,
      mode: policy.resetMode,
      idleTimeoutSec: policy.idleTimeoutSec,
      maxAgeSec: policy.maxAgeSec,
      dailyResetAt: policy.dailyResetAt,
      timezone: policy.resetTimezone,
    },
  })
  return freshness.fresh ? { stale: false } : { stale: true, reason: freshness.reason }
}

export function resetConnectorSessionRuntime(session: Session, reason: string): number {
  return resetSessionRuntime(session, reason)
}

export function shouldReplyToInboundMessage(params: {
  msg: InboundMessage
  session?: Partial<Session> | null
  policy: ResolvedConnectorSessionPolicy
}): { replyToMessageId?: string; threadId?: string } {
  const { msg, session, policy } = params
  const replyToMessageId = (() => {
    if (!msg.messageId) return undefined
    if (policy.replyMode === 'off') return undefined
    if (policy.replyMode === 'all') return msg.messageId
    const priorOutbound = session?.connectorContext?.lastOutboundMessageId
    return priorOutbound ? undefined : msg.messageId
  })()
  const threadId = policy.threadBinding !== 'off'
    ? (msg.threadId || session?.connectorContext?.threadId || undefined)
    : undefined
  return { replyToMessageId, threadId }
}

export function isReplyToLastOutbound(msg: InboundMessage, session?: Partial<Session> | null): boolean {
  if (!msg.replyToMessageId) return false
  return msg.replyToMessageId === session?.connectorContext?.lastOutboundMessageId
}

export function buildConnectorDoctorWarnings(params: {
  connector: Connector
  msg?: InboundMessage | null
  session?: Partial<Session> | null
}): string[] {
  const { connector, msg, session } = params
  const sampleMsg = msg || {
    platform: connector.platform,
    channelId: 'sample-channel',
    senderId: 'sample-user',
    senderName: 'Sample User',
    text: 'sample',
    isGroup: false,
  } as InboundMessage
  const policy = resolveConnectorSessionPolicy(connector, sampleMsg, session)
  const warnings: string[] = []
  const agents = loadAgents()
  const chatrooms = loadChatrooms()

  if (!connector.agentId && !connector.chatroomId) {
    warnings.push('No agent or chatroom is assigned, so inbound messages cannot be handled.')
  }
  if (connector.agentId && connector.chatroomId) {
    warnings.push('Both agentId and chatroomId are set; chatroom routing will win and the direct agent assignment is ignored.')
  }
  if (connector.agentId && !agents[connector.agentId]) {
    warnings.push(`Assigned agent "${connector.agentId}" was not found, so direct connector routing will fail.`)
  }
  if (connector.chatroomId) {
    const chatroom = chatrooms[connector.chatroomId]
    if (!chatroom) {
      warnings.push(`Assigned chatroom "${connector.chatroomId}" was not found, so inbound messages cannot be routed.`)
    } else if (!Array.isArray(chatroom.agentIds) || chatroom.agentIds.length === 0) {
      warnings.push(`Assigned chatroom "${chatroom.name || connector.chatroomId}" has no agents, so inbound messages will not get a response.`)
    }
  }
  const dmPolicy = parsePairingPolicy(connector.config?.dmPolicy, 'open')
  const globalWhatsAppAllowFrom = connector.platform === 'whatsapp'
    ? getWhatsAppApprovedSenderIds(loadSettings().whatsappApprovedContacts)
    : []
  const configuredAllowFrom = parseAllowFromCsv([
    connector.config?.allowFrom,
    ...globalWhatsAppAllowFrom,
  ].filter(Boolean).join(','))
  const storedAllowFrom = listStoredAllowedSenders(connector.id)
  if (parseBool(connector.config?.statusReactions, true) && connector.platform === 'telegram') {
    warnings.push('Status reactions are enabled, but Telegram support is partial and may no-op depending on bot permissions.')
  }
  if (parseBool(connector.config?.typingIndicators, true) && connector.platform === 'slack') {
    warnings.push('Typing indicators are enabled, but Slack support is unavailable over the current connector transport.')
  }
  if (policy.scope === 'main') {
    warnings.push('Session scope is "main", which can blend unrelated connector conversations into one session.')
  }
  if (policy.groupPolicy === 'open') {
    warnings.push('Group policy is "open", so the agent may speak in group chats without being mentioned or replied to.')
  }
  if (policy.replyMode === 'off') {
    warnings.push('Reply mode is "off", so outbound messages will not stay attached to the originating inbound message.')
  }
  if (policy.threadBinding === 'off') {
    warnings.push('Thread binding is disabled, so threaded conversations may collapse into the parent channel session.')
  }
  if ((policy.idleTimeoutSec ?? 0) === 0 || (policy.maxAgeSec ?? 0) === 0) {
    warnings.push('Session freshness reset is disabled, so stale connector context can accumulate indefinitely.')
  }
  if (policy.resetMode === 'daily' && !policy.dailyResetAt) {
    warnings.push('Daily reset mode is enabled without a valid reset time, so freshness falls back to max-age or idle checks only.')
  }
  if (policy.resetMode === 'daily' && !policy.resetTimezone) {
    warnings.push('Daily reset mode uses the server timezone. Set sessionResetTimezone explicitly when the connector follows a different local day boundary.')
  }
  if (policy.inboundDebounceMs === 0) {
    warnings.push('Inbound debounce is disabled, so rapid message bursts can trigger duplicate or fragmented autonomous runs.')
  }
  if (!sampleMsg.isGroup && dmPolicy === 'open') {
    warnings.push('DM policy is "open", so any direct sender can start a connector session without approval.')
  }
  if (dmPolicy === 'allowlist' && configuredAllowFrom.length === 0 && storedAllowFrom.length === 0) {
    warnings.push('DM policy is "allowlist", but no approved sender IDs are configured or paired yet.')
  }
  if (dmPolicy === 'pairing' && configuredAllowFrom.length === 0 && storedAllowFrom.length === 0) {
    warnings.push('DM policy is "pairing" with no approved senders, so the first pairing approval will bootstrap trust from any DM.')
  }
  if (connector.config?.providerOverride && !policy.providerOverride) {
    warnings.push(`Provider override "${connector.config.providerOverride}" is invalid, so connector runs fall back to the agent provider.`)
  }
  if ((policy.providerOverride || policy.modelOverride) && connector.chatroomId) {
    warnings.push('Provider/model overrides are configured, but this connector routes to a chatroom. Those overrides only apply to direct agent connector sessions.')
  }
  if (policy.providerOverride && policy.modelOverride) {
    const provider = getProvider(policy.providerOverride)
    if (provider && provider.models.length > 0 && !provider.models.includes(policy.modelOverride)) {
      warnings.push(`Model override "${policy.modelOverride}" is not in the advertised model list for provider "${policy.providerOverride}".`)
    }
  }
  if (policy.providerOverride && connector.agentId) {
    const credentials = loadCredentials()
    const agent = agents[connector.agentId]
    if (agent) {
      const provider = getProvider(policy.providerOverride)
      const candidateIds = [agent.credentialId, ...(agent.fallbackCredentialIds || [])].filter(Boolean) as string[]
      const hasMatchingCredential = candidateIds.some((credentialId) => credentials[credentialId]?.provider === policy.providerOverride)
      if (provider?.requiresApiKey && !hasMatchingCredential) {
        warnings.push(`Provider override "${policy.providerOverride}" requires matching API credentials, but the assigned agent has no primary/fallback credential for that provider.`)
      }
      if (provider?.requiresEndpoint && !(agent.apiEndpoint || provider.defaultEndpoint)) {
        warnings.push(`Provider override "${policy.providerOverride}" requires an endpoint, but the assigned agent does not provide one.`)
      }
    }
  }
  if (!connector.credentialId && connector.platform !== 'whatsapp' && connector.platform !== 'openclaw' && connector.platform !== 'signal' && connector.platform !== 'email') {
    warnings.push('This connector does not have stored credentials, so startup depends on inline config or will fail.')
  }
  return warnings
}
