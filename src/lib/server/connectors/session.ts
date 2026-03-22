import { genId } from '@/lib/id'
import { getProvider } from '@/lib/providers'
import type { Agent, Connector, MessageSource, Session } from '@/types'
import { WORKSPACE_DIR } from '../data-dir'
import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import { resolveEffectiveSessionMemoryScopeMode } from '@/lib/server/memory/session-memory-scope'
import { syncSessionArchiveMemory } from '@/lib/server/memory/session-archive-memory'
import {
  appendMessage,
  getLastMessage,
} from '@/lib/server/messages/message-repository'
import { loadAgents, loadSessions, loadStoredItem, upsertStoredItem } from '../storage'
import { notify } from '../ws-hub'
import {
  buildConnectorConversationKey,
  getConnectorSessionStaleness,
  resetConnectorSessionRuntime,
  resolveConnectorSessionPolicy,
} from './policy'
import { isDirectConnectorSession } from './session-kind'
import { resolveThreadPersonaLabel } from './thread-context'
import type { InboundMessage } from './types'
import { getEnabledCapabilitySelection } from '@/lib/capability-selection'

export type ConnectorSession = Session
export type ConnectorAgent = Agent

export interface ConnectorRuntimeDefaults {
  provider: Session['provider']
  model: string
  apiEndpoint: string | null
  thinkingLevel: Session['connectorThinkLevel']
}

export interface ResolvedDirectSession {
  session: ConnectorSession
  sessionKey: string
  wasCreated: boolean
  staleReason?: string | null
  clearedMessages?: number
}

export function findDirectSessionForInbound(connector: Connector, msg: InboundMessage): ConnectorSession | null {
  if (connector.chatroomId) return null
  const effectiveAgentId = msg.agentIdOverride || connector.agentId
  const channelIds = new Set([msg.channelId, msg.channelIdAlt].filter(Boolean))
  const senderIds = new Set([msg.senderId, msg.senderIdAlt].filter(Boolean))
  const sessions = Object.values(loadSessions() as Record<string, ConnectorSession>)
  const candidates = sessions.filter((session) =>
    isDirectConnectorSession(session)
      && session?.agentId === effectiveAgentId
      && session?.connectorContext?.connectorId === connector.id
      && (
        channelIds.has(session?.connectorContext?.channelId || '')
        || channelIds.has(session?.connectorContext?.channelIdAlt || '')
        || (session?.connectorContext?.allKnownPeerIds || []).some((id) => channelIds.has(id))
      ),
  )
  if (msg.threadId) {
    const threadExact = candidates.find((session) => session?.connectorContext?.threadId === msg.threadId)
    if (threadExact) return threadExact
    return null
  }
  const senderExact = candidates.find((session) =>
    senderIds.has(session?.connectorContext?.senderId || '')
    || senderIds.has(session?.connectorContext?.senderIdAlt || ''),
  )
  if (senderExact) return senderExact

  // Fallback: match via allKnownPeerIds (covers WhatsApp phone↔LID alternation)
  const peerIdMatch = candidates.find((s) =>
    (s.connectorContext?.allKnownPeerIds || []).some((id) => senderIds.has(id)),
  )
  if (peerIdMatch) return peerIdMatch

  return candidates.length === 1 ? candidates[0] : null
}

export function persistSessionRecord(session: ConnectorSession): void {
  session.updatedAt = Date.now()
  upsertStoredItem('sessions', session.id, session)
  notify('sessions')
}

export function updateSessionConnectorContext(
  session: ConnectorSession,
  connector: Connector,
  msg: InboundMessage,
  sessionKey: string,
): void {
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  session.connectorContext = {
    ...(session.connectorContext || {}),
    connectorId: connector.id,
    platform: connector.platform,
    channelId: msg.channelId,
    channelIdAlt: msg.channelIdAlt || session.connectorContext?.channelIdAlt || null,
    senderId: msg.senderId,
    senderIdAlt: msg.senderIdAlt || session.connectorContext?.senderIdAlt || null,
    senderName: msg.senderName,
    senderAvatarUrl: msg.senderAvatarUrl || session.connectorContext?.senderAvatarUrl || null,
    sessionKey,
    peerKey: msg.senderIdAlt || msg.senderId,
    scope: policy.scope,
    replyMode: policy.replyMode,
    threadBinding: policy.threadBinding,
    groupPolicy: policy.groupPolicy,
    threadId: msg.threadId || session.connectorContext?.threadId || null,
    threadTitle: msg.threadTitle || session.connectorContext?.threadTitle || null,
    threadPersonaLabel: resolveThreadPersonaLabel(msg) || session.connectorContext?.threadPersonaLabel || null,
    threadParentChannelId: msg.threadParentChannelId || session.connectorContext?.threadParentChannelId || null,
    threadParentChannelName: msg.threadParentChannelName || session.connectorContext?.threadParentChannelName || null,
    isGroup: !!msg.isGroup,
    isOwnerConversation: msg.isOwnerConversation === true,
    lastInboundAt: Date.now(),
    lastInboundMessageId: msg.messageId || null,
    lastInboundReplyToMessageId: msg.replyToMessageId || null,
    lastInboundThreadId: msg.threadId || null,
    lastOutboundAt: session.connectorContext?.lastOutboundAt ?? null,
    lastOutboundMessageId: session.connectorContext?.lastOutboundMessageId ?? null,
    lastResetAt: session.connectorContext?.lastResetAt ?? null,
    lastResetReason: session.connectorContext?.lastResetReason ?? null,
  }

  // Accumulate all known peer IDs so future lookups can match across JID formats
  const knownIds = new Set(session.connectorContext.allKnownPeerIds || [])
  for (const id of [msg.senderId, msg.senderIdAlt, msg.channelId, msg.channelIdAlt].filter(Boolean) as string[]) {
    knownIds.add(id)
  }
  session.connectorContext.allKnownPeerIds = [...knownIds]
}

export function describeSessionControls(
  session: ConnectorSession,
  connector: Connector,
  msg: InboundMessage,
): string {
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  const context = session.connectorContext || {}
  const sessionAgeSec = Math.max(0, Math.round((Date.now() - (session.createdAt || Date.now())) / 1000))
  const idleSec = Math.max(0, Math.round((Date.now() - (session.lastActiveAt || Date.now())) / 1000))
  return [
    `Chat controls for ${connector.platform}/${connector.name}:`,
    `- Chat: ${session.id}`,
    `- Scope: ${policy.scope}`,
    `- Reply mode: ${policy.replyMode}`,
    `- Thread binding: ${policy.threadBinding}`,
    `- Group policy: ${policy.groupPolicy}`,
    `- Reset mode: ${policy.resetMode}`,
    `- Idle timeout: ${policy.idleTimeoutSec ?? 0}s`,
    `- Max age: ${policy.maxAgeSec ?? 0}s`,
    `- Daily reset: ${policy.dailyResetAt || 'off'}`,
    `- Reset timezone: ${policy.resetTimezone || 'local'}`,
    `- Debounce: ${policy.inboundDebounceMs}ms`,
    `- Typing indicators: ${policy.typingIndicators ? 'on' : 'off'}`,
    `- Thinking: ${policy.thinkingLevel || session.thinkingLevel || 'inherit'}`,
    `- Model: ${session.provider}/${session.model}`,
    `- Last outbound message: ${context.lastOutboundMessageId || 'none'}`,
    `- Thread: ${context.threadId || 'none'}`,
    `- Thread title: ${context.threadTitle || 'none'}`,
    `- Thread persona: ${context.threadPersonaLabel || 'none'}`,
    `- Session age: ${sessionAgeSec}s`,
    `- Idle for: ${idleSec}s`,
  ].join('\n')
}

function normalizeSessionSettingKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_-]+/g, '')
}

export function applySessionSetting(
  session: ConnectorSession,
  keyRaw: string,
  valueRaw: string,
  msg: InboundMessage,
): string {
  const key = normalizeSessionSettingKey(keyRaw)
  const value = valueRaw.trim()
  const asInt = () => {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid numeric value for ${keyRaw}: ${valueRaw}`)
    }
    return parsed
  }
  const asEnum = <T extends string>(allowed: readonly T[], label: string): T | null => {
    if (!value) return null
    const normalized = value.toLowerCase()
    if ((allowed as readonly string[]).includes(normalized)) return normalized as T
    throw new Error(`Invalid ${label}. Use one of: ${allowed.join(', ')}.`)
  }

  switch (key) {
    case 'think':
    case 'thinkinglevel':
      session.connectorThinkLevel = asEnum(['minimal', 'low', 'medium', 'high'] as const, '/think level')
      return `Connector thinking level set to ${session.connectorThinkLevel || 'inherit'}.`
    case 'reply':
    case 'replymode':
      session.connectorReplyMode = asEnum(['off', 'first', 'all'] as const, 'reply mode')
      return `Reply mode set to ${session.connectorReplyMode || 'inherit'}.`
    case 'scope':
    case 'sessionscope':
      session.connectorSessionScope = asEnum(['main', 'channel', 'peer', 'channel-peer', 'thread'] as const, 'session scope')
      return `Session scope set to ${session.connectorSessionScope || 'inherit'}.`
    case 'thread':
    case 'threadbinding':
      session.connectorThreadBinding = asEnum(['off', 'prefer', 'strict'] as const, 'thread binding')
      if (!value) {
        session.connectorContext = { ...(session.connectorContext || {}), threadId: null }
      } else if (session.connectorThreadBinding === 'strict' && msg.threadId) {
        session.connectorContext = { ...(session.connectorContext || {}), threadId: msg.threadId }
      }
      return `Thread binding set to ${session.connectorThreadBinding || 'inherit'}.`
    case 'group':
    case 'grouppolicy':
      session.connectorGroupPolicy = asEnum(['open', 'mention', 'reply-or-mention', 'disabled'] as const, 'group policy')
      return `Group policy set to ${session.connectorGroupPolicy || 'inherit'}.`
    case 'idle':
    case 'idletimeout':
      session.connectorIdleTimeoutSec = asInt()
      return `Idle timeout set to ${session.connectorIdleTimeoutSec}s.`
    case 'maxage':
      session.connectorMaxAgeSec = asInt()
      return `Max age set to ${session.connectorMaxAgeSec}s.`
    case 'reset':
    case 'resetmode': {
      const normalized = value.toLowerCase()
      if (!value) {
        session.sessionResetMode = null
        return 'Reset mode set to inherit.'
      }
      if (normalized !== 'idle' && normalized !== 'daily') {
        throw new Error('Reset mode must be "idle" or "daily".')
      }
      session.sessionResetMode = normalized
      return `Reset mode set to ${session.sessionResetMode}.`
    }
    case 'daily':
    case 'dailyreset':
    case 'dailyresetat':
      if (!value) {
        session.sessionDailyResetAt = null
        return 'Daily reset time cleared.'
      }
      if (!/^\d{1,2}:\d{2}$/.test(value)) {
        throw new Error('Daily reset time must be in HH:MM format.')
      }
      session.sessionDailyResetAt = value
      return `Daily reset time set to ${session.sessionDailyResetAt}.`
    case 'timezone':
    case 'resettimezone':
      session.sessionResetTimezone = value || null
      return `Reset timezone set to ${session.sessionResetTimezone || 'inherit/local'}.`
    case 'model':
      session.model = value
      return `Model set to ${session.model}.`
    case 'provider': {
      const provider = getProvider(value)
      if (!provider) {
        throw new Error(`Unknown provider "${value}".`)
      }
      session.provider = provider.id as Session['provider']
      session.apiEndpoint = provider.defaultEndpoint || session.apiEndpoint || null
      return `Provider set to ${session.provider}.`
    }
    default:
      throw new Error(`Unknown session setting "${keyRaw}".`)
  }
}

export function applyConnectorRuntimeDefaults(
  session: ConnectorSession,
  defaults: ConnectorRuntimeDefaults,
): void {
  session.provider = defaults.provider
  session.model = defaults.model
  session.apiEndpoint = defaults.apiEndpoint
  session.connectorThinkLevel = defaults.thinkingLevel
}

export function resolveDirectSession(params: {
  connector: Connector
  msg: InboundMessage
  agent: ConnectorAgent
}): ResolvedDirectSession {
  const { connector, msg, agent } = params
  if (msg.isOwnerConversation) {
    const existingThreadId = typeof agent.threadSessionId === 'string' ? agent.threadSessionId : ''
    const existingThreadSession = existingThreadId
      ? loadStoredItem('sessions', existingThreadId) as ConnectorSession | null
      : null
    const threadSession = ensureAgentThreadSession(agent.id) as ConnectorSession | null
    if (!threadSession) {
      throw new Error(`Failed to resolve main thread session for agent ${agent.id}`)
    }
    updateSessionConnectorContext(threadSession, connector, msg, threadSession.id)
    persistSessionRecord(threadSession)
    return {
      session: threadSession,
      sessionKey: threadSession.id,
      wasCreated: !existingThreadSession,
    }
  }

  const policySeed = resolveConnectorSessionPolicy(connector, msg)
  const providerInfo = policySeed.providerOverride ? getProvider(policySeed.providerOverride) : null
  const defaultProvider: Session['provider'] = providerInfo?.id || (agent.provider === 'claude-cli' ? 'anthropic' : agent.provider)
  const defaultModel = policySeed.modelOverride || agent.model
  const defaultApiEndpoint = agent.apiEndpoint || providerInfo?.defaultEndpoint || null
  const runtimeDefaults: ConnectorRuntimeDefaults = {
    provider: defaultProvider,
    model: defaultModel,
    apiEndpoint: defaultApiEndpoint,
    thinkingLevel: policySeed.thinkingLevel || null,
  }
  const sessionKey = buildConnectorConversationKey({
    connector,
    msg,
    agentId: agent.id,
    policy: policySeed,
  })
  const sessions = loadSessions()
  let session = Object.values(sessions as Record<string, ConnectorSession>).find((item) => item?.name === sessionKey)
  if (!session) {
    session = findDirectSessionForInbound(connector, msg) || undefined
  }
  let wasCreated = false
  if (!session) {
    const id = genId()
    session = {
      id,
      name: sessionKey,
      cwd: WORKSPACE_DIR,
      user: 'connector',
      provider: defaultProvider,
      model: defaultModel,
      credentialId: agent.credentialId || null,
      fallbackCredentialIds: Array.isArray(agent.fallbackCredentialIds) ? [...agent.fallbackCredentialIds] : [],
      apiEndpoint: defaultApiEndpoint,
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: {
        claudeCode: null,
        codex: null,
        opencode: null,
        gemini: null,
      },
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human' as const,
      agentId: agent.id,
      ...getEnabledCapabilitySelection(agent),
      memoryScopeMode: resolveEffectiveSessionMemoryScopeMode({
        id,
        agentId: agent.id,
        memoryScopeMode: agent.memoryScopeMode ?? null,
        connectorContext: null,
        name: sessionKey,
        user: 'connector',
      }, agent.memoryScopeMode ?? null),
      thinkingLevel: agent.thinkingLevel || null,
      connectorThinkLevel: policySeed.thinkingLevel || null,
    }
    wasCreated = true
  }
  session.name = sessionKey
  session.agentId = agent.id
  const capabilitySelection = getEnabledCapabilitySelection(agent)
  if (!Array.isArray(session.tools)) session.tools = capabilitySelection.tools
  if (!Array.isArray(session.extensions)) session.extensions = capabilitySelection.extensions
  session.provider = defaultProvider
  session.model = defaultModel
  if (session.credentialId === undefined) session.credentialId = agent.credentialId || null
  if (!Array.isArray(session.fallbackCredentialIds) && Array.isArray(agent.fallbackCredentialIds)) {
    session.fallbackCredentialIds = [...agent.fallbackCredentialIds]
  }
  if (session.apiEndpoint === undefined || session.apiEndpoint === null) session.apiEndpoint = defaultApiEndpoint
  if ((session.connectorThinkLevel === undefined || session.connectorThinkLevel === null) && policySeed.thinkingLevel) {
    session.connectorThinkLevel = policySeed.thinkingLevel
  }
  session.memoryScopeMode = resolveEffectiveSessionMemoryScopeMode(session, agent.memoryScopeMode ?? null)

  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  const staleness = getConnectorSessionStaleness(session, policy)
  let clearedMessages = 0
  if (staleness.stale) {
    try { syncSessionArchiveMemory(session, { agent }) } catch { /* archive sync is best-effort */ }
    clearedMessages = resetConnectorSessionRuntime(session, staleness.reason || 'session_refresh')
    applyConnectorRuntimeDefaults(session, {
      ...runtimeDefaults,
      thinkingLevel: policySeed.thinkingLevel || session.connectorThinkLevel || null,
    })
  }
  updateSessionConnectorContext(session, connector, msg, sessionKey)
  upsertStoredItem('sessions', session.id, session)
  return {
    session,
    sessionKey,
    wasCreated,
    staleReason: staleness.reason || null,
    clearedMessages,
  }
}

function mirrorConnectorMessageToAgentThread(
  session: ConnectorSession,
  message: Record<string, unknown>,
): void {
  if (!session.agentId) return
  if (typeof session.name !== 'string' || !session.name.startsWith('connector:')) return
  if (session.connectorContext?.isOwnerConversation !== true) return

  const agents = loadAgents()
  const agent = agents[session.agentId]
  const threadSession = agent?.threadSessionId
    ? loadStoredItem('sessions', agent.threadSessionId) as ConnectorSession | null
    : ensureAgentThreadSession(session.agentId)
  if (!threadSession || threadSession.id === session.id) return

  const last = getLastMessage(threadSession.id)
  const source = message.source as MessageSource | undefined
  const lastSource = (last?.source || null) as MessageSource | null
  if (
    last
    && last.role === message.role
    && last.text === message.text
    && lastSource?.platform === source?.platform
    && lastSource?.connectorId === source?.connectorId
    && lastSource?.channelId === source?.channelId
    && lastSource?.messageId === source?.messageId
  ) {
    return
  }

  const mirrorMsg = {
    ...message,
    time: typeof message.time === 'number' ? message.time : Date.now(),
    historyExcluded: true,
  } as Session['messages'][number]
  appendMessage(threadSession.id, mirrorMsg)
  threadSession.lastActiveAt = Date.now()

  upsertStoredItem('sessions', threadSession.id, threadSession)
  notify('sessions')
}

export function pushSessionMessage(
  session: ConnectorSession,
  role: 'user' | 'assistant',
  text: string,
  extra: Record<string, unknown> = {},
): void {
  if (!text.trim()) return
  const message = { role, text: text.trim(), time: Date.now(), ...extra }
  appendMessage(session.id, message as Session['messages'][number])
  session.lastActiveAt = Date.now()
  mirrorConnectorMessageToAgentThread(session, message)
}

export function modelHistoryTail(
  messages: Session['messages'] | null | undefined,
  limit = 20,
  maxChars = 0,
): Session['messages'] {
  const filtered = (Array.isArray(messages) ? messages : []).filter((message) => message?.historyExcluded !== true)
  let tail = filtered.slice(-limit)
  if (maxChars > 0) {
    let chars = 0
    let startIndex = tail.length
    for (let i = tail.length - 1; i >= 0; i--) {
      const msgChars = (tail[i].text?.length || 0) + 20
      if (chars + msgChars > maxChars) break
      chars += msgChars
      startIndex = i
    }
    tail = tail.slice(startIndex)
  }
  return tail
}

/**
 * Like `modelHistoryTail`, but prepends `[senderName]` to user messages
 * so the model can distinguish who said what in multi-sender histories.
 */
export function modelHistoryTailWithAttribution(
  messages: Session['messages'] | null | undefined,
  limit = 20,
  maxChars = 0,
): Session['messages'] {
  const tail = modelHistoryTail(messages, limit, maxChars)
  return tail.map((m) => {
    if (m.role !== 'user') return m
    const name = m.source?.senderName
    if (!name || m.text.startsWith(`[${name}]`)) return m
    return { ...m, text: `[${name}] ${m.text}` }
  })
}

export function persistSession(session: ConnectorSession): void {
  session.updatedAt = Date.now()
  upsertStoredItem('sessions', session.id, session)
  notify('sessions')
  notify(`messages:${session.id}`)
}
