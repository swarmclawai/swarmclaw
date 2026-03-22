import { getProvider } from '@/lib/providers'
import type { Connector } from '@/types'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { syncSessionArchiveMemory } from '@/lib/server/memory/session-archive-memory'
import { getMessages, replaceAllMessages } from '@/lib/server/messages/message-repository'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { resolvePairingAccess } from './access'
import {
  addAllowedSender,
  approvePairingCode,
  createOrTouchPairingRequest,
  listPendingPairingRequests,
  listStoredAllowedSenders,
} from './pairing'
import {
  buildConnectorDoctorWarnings,
  resetConnectorSessionRuntime,
  resolveConnectorSessionPolicy,
} from './policy'
import {
  applyConnectorRuntimeDefaults,
  applySessionSetting,
  describeSessionControls,
  persistSession,
  pushSessionMessage,
  type ConnectorAgent,
  type ConnectorSession,
  updateSessionConnectorContext,
} from './session'
import type { InboundMessage } from './types'
import { errorMessage } from '@/lib/shared-utils'

export type ConnectorCommandName =
  | 'help'
  | 'status'
  | 'new'
  | 'reset'
  | 'compact'
  | 'think'
  | 'pair'
  | 'session'
  | 'focus'
  | 'doctor'

export interface ParsedConnectorCommand {
  name: ConnectorCommandName
  args: string
}

export function parseConnectorCommand(text: string): ParsedConnectorCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...rest] = trimmed.split(/\s+/)
  const name = head.slice(1).toLowerCase()
  const args = rest.join(' ').trim()
  switch (name) {
    case 'help':
    case 'status':
    case 'new':
    case 'reset':
    case 'compact':
    case 'think':
    case 'pair':
    case 'session':
    case 'focus':
    case 'doctor':
      return { name, args } as ParsedConnectorCommand
    default:
      return null
  }
}

export async function handlePairCommand(params: {
  connector: Connector
  msg: InboundMessage
  args: string
}): Promise<string> {
  const { connector, msg, args } = params
  const access = resolvePairingAccess(connector, msg)
  const parts = args.split(/\s+/).map((item) => item.trim()).filter(Boolean)
  const subcommand = (parts[0] || 'status').toLowerCase()

  if (subcommand === 'request') {
    const request = createOrTouchPairingRequest({
      connectorId: connector.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      channelId: msg.channelId,
    })
    return request.created
      ? `Pairing request created. Share this code with an approved user: ${request.code}`
      : `Pairing request is already pending. Your code is: ${request.code}`
  }

  if (subcommand === 'list') {
    if (access.hasAnyApprover && !access.isAllowed) {
      return 'Pairing list is restricted to approved senders.'
    }
    const pending = listPendingPairingRequests(connector.id)
    if (!pending.length) return 'No pending pairing requests.'
    const lines = pending.slice(0, 20).map((entry) => {
      const ageMin = Math.max(1, Math.round((Date.now() - entry.updatedAt) / 60_000))
      const sender = entry.senderName ? `${entry.senderName} (${entry.senderId})` : entry.senderId
      return `- ${entry.code} -> ${sender} (${ageMin}m ago)`
    })
    return `Pending pairing requests (${pending.length}):\n${lines.join('\n')}`
  }

  if (subcommand === 'approve') {
    const code = (parts[1] || '').trim()
    if (!code) return 'Usage: /pair approve <code>'
    if (access.hasAnyApprover && !access.isAllowed) {
      return 'Pairing approvals are restricted to approved senders.'
    }
    const approved = approvePairingCode(connector.id, code)
    if (!approved.ok) return approved.reason || 'Pairing approval failed.'
    const sender = approved.senderName ? `${approved.senderName} (${approved.senderId})` : approved.senderId
    return `Pairing approved: ${sender}`
  }

  if (subcommand === 'allow') {
    const senderId = (parts[1] || '').trim()
    if (!senderId) return 'Usage: /pair allow <senderId>'
    if (access.hasAnyApprover && !access.isAllowed) {
      return 'Allowlist updates are restricted to approved senders.'
    }
    const result = addAllowedSender(connector.id, senderId)
    if (!result.normalized) return 'Could not parse senderId.'
    return result.added
      ? `Allowed sender: ${result.normalized}`
      : `Sender is already allowed: ${result.normalized}`
  }

  const pending = listPendingPairingRequests(connector.id)
  const stored = listStoredAllowedSenders(connector.id)
  const policyLine = `Policy: ${access.policy}`
  const approvedLine = `You are ${access.isAllowed ? 'approved' : 'not approved'} as ${msg.senderId}`
  return [
    'Pairing controls:',
    policyLine,
    approvedLine,
    `- Stored approvals: ${stored.length}`,
    `- Pending requests: ${pending.length}`,
    '- Commands: /pair request, /pair list, /pair approve <code>, /pair allow <senderId>',
  ].join('\n')
}

function summarizeForCompaction(messages: Array<{ role?: string; text?: string }>): string {
  const preview = messages
    .slice(-8)
    .map((message, index) => {
      const role = (message.role || 'unknown').toUpperCase()
      const body = (message.text || '').replace(/\s+/g, ' ').trim()
      const clipped = body.length > 180 ? `${body.slice(0, 177)}...` : body
      return `${index + 1}. [${role}] ${clipped || '(no text)'}`
    })
  if (!preview.length) return 'No earlier messages to summarize.'
  return preview.join('\n')
}

export async function handleConnectorCommand(params: {
  command: ParsedConnectorCommand
  connector: Connector
  session: ConnectorSession
  msg: InboundMessage
  agentName: string
  inboundText: string
}): Promise<string> {
  const { command, connector, session, msg, agentName, inboundText } = params

  if (command.name === 'help') {
    const text = [
      'Connector commands:',
      '/status — Show active session status',
      '/new or /reset — Clear this connector conversation thread',
      '/compact [keepLastN] — Summarize older history and keep recent messages (default 10)',
      '/think <minimal|low|medium|high> — Set connector thread reasoning guidance',
      '/session — Show session controls',
      '/session set <scope|reply|thread|group|idle|maxAge|resetMode|dailyResetAt|timezone|think|model|provider> <value> — Patch this connector session',
      '/focus here|clear — Bind or clear focus on the current thread/topic',
      '/doctor — Show autonomy and safety warnings for this connector/session',
      '/pair — Pairing/access controls (status, request, list, approve, allow)',
      '/help — Show this list',
    ].join('\n')
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'status') {
    const policy = resolveConnectorSessionPolicy(connector, msg, session)
    const all = getMessages(session.id)
    const userCount = all.filter((message) => message?.role === 'user').length
    const assistantCount = all.filter((message) => message?.role === 'assistant').length
    const toolsCount = getEnabledCapabilityIds(session).length
    const statusText = [
      `Status for ${connector.platform} / ${connector.name}:`,
      `- Agent: ${agentName}`,
      `- Session: ${session.id}`,
      `- Model: ${session.provider}/${session.model}`,
      `- Messages: ${all.length} (${userCount} user, ${assistantCount} assistant)`,
      `- Tools enabled: ${toolsCount}`,
      `- Channel: ${msg.channelName || msg.channelId}`,
      `- Last active: ${new Date(session.lastActiveAt || session.createdAt || Date.now()).toLocaleString()}`,
      `- Reset mode: ${policy.resetMode}`,
      `- Reply mode: ${policy.replyMode}`,
      `- Scope: ${policy.scope}`,
    ].join('\n')
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', statusText)
    persistSession(session)
    return statusText
  }

  if (command.name === 'new' || command.name === 'reset') {
    const agent = session.agentId ? (loadAgents() as Record<string, ConnectorAgent>)[session.agentId] : undefined
    try { syncSessionArchiveMemory(session, { agent }) } catch { /* best effort */ }
    const cleared = resetConnectorSessionRuntime(session, 'manual_reset')
    const policy = resolveConnectorSessionPolicy(connector, msg, session)
    const providerInfo = policy.providerOverride ? getProvider(policy.providerOverride) : null
    applyConnectorRuntimeDefaults(session, {
      provider: providerInfo?.id || session.provider,
      model: policy.modelOverride || session.model,
      apiEndpoint: providerInfo?.defaultEndpoint || session.apiEndpoint || null,
      thinkingLevel: policy.thinkingLevel || session.connectorThinkLevel || null,
    })
    updateSessionConnectorContext(session, connector, msg, session.name || session.id)
    persistSession(session)
    return `Reset complete for ${connector.platform} channel thread. Cleared ${cleared} message(s).`
  }

  if (command.name === 'compact') {
    const keepParsed = Number.parseInt(command.args, 10)
    const keepLastN = Number.isFinite(keepParsed) ? Math.max(4, Math.min(50, keepParsed)) : 10
    const history = getMessages(session.id)
    if (history.length <= keepLastN) {
      const text = `Nothing to compact. Current history has ${history.length} message(s), keepLastN=${keepLastN}.`
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    const oldMessages = history.slice(0, -keepLastN)
    const recentMessages = history.slice(-keepLastN)
    const summary = summarizeForCompaction(oldMessages)
    const summaryMessage = {
      role: 'assistant' as const,
      text: `[Context summary: compacted ${oldMessages.length} message(s)]\n${summary}`,
      time: Date.now(),
      kind: 'system' as const,
    }
    replaceAllMessages(session.id, [summaryMessage, ...recentMessages])
    session.lastActiveAt = Date.now()
    const text = `Compacted ${oldMessages.length} message(s). Kept ${recentMessages.length} recent message(s) plus a summary.`
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'think') {
    const requested = command.args.trim().toLowerCase()
    const allowed = new Set(['minimal', 'low', 'medium', 'high'] as const)
    if (!requested) {
      const policy = resolveConnectorSessionPolicy(connector, msg, session)
      const current = typeof policy.thinkingLevel === 'string' && allowed.has(policy.thinkingLevel)
        ? policy.thinkingLevel
        : 'medium'
      const text = `Current /think level: ${current}. Usage: /think <minimal|low|medium|high>.`
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    if (
      requested !== 'minimal'
      && requested !== 'low'
      && requested !== 'medium'
      && requested !== 'high'
    ) {
      const text = 'Invalid /think level. Use one of: minimal, low, medium, high.'
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    session.connectorThinkLevel = requested
    session.lastActiveAt = Date.now()
    const text = `Set /think level to ${requested} for this connector thread.`
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'doctor') {
    const warnings = buildConnectorDoctorWarnings({ connector, msg, session })
    const text = warnings.length
      ? ['Connector doctor:', ...warnings.map((item) => `- ${item}`)].join('\n')
      : 'Connector doctor: no obvious autonomy or safety issues detected.'
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'session') {
    const parts = command.args.split(/\s+/).map((item) => item.trim()).filter(Boolean)
    if (!parts.length || parts[0].toLowerCase() === 'show' || parts[0].toLowerCase() === 'status') {
      const text = describeSessionControls(session, connector, msg)
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    if (parts[0].toLowerCase() === 'reset') {
      const agent = session.agentId ? (loadAgents() as Record<string, ConnectorAgent>)[session.agentId] : undefined
      try { syncSessionArchiveMemory(session, { agent }) } catch { /* best effort */ }
      const cleared = resetConnectorSessionRuntime(session, 'manual_reset')
      const policy = resolveConnectorSessionPolicy(connector, msg, session)
      const providerInfo = policy.providerOverride ? getProvider(policy.providerOverride) : null
      applyConnectorRuntimeDefaults(session, {
        provider: providerInfo?.id || session.provider,
        model: policy.modelOverride || session.model,
        apiEndpoint: providerInfo?.defaultEndpoint || session.apiEndpoint || null,
        thinkingLevel: policy.thinkingLevel || session.connectorThinkLevel || null,
      })
      updateSessionConnectorContext(session, connector, msg, session.name || session.id)
      persistSession(session)
      return `Connector session reset. Cleared ${cleared} message(s).`
    }
    if (parts[0].toLowerCase() === 'set') {
      const key = parts[1] || ''
      const value = parts.slice(2).join(' ').trim()
      if (!key) return 'Usage: /session set <scope|reply|thread|group|idle|maxAge|resetMode|dailyResetAt|timezone|think|model|provider> <value>'
      try {
        const text = applySessionSetting(session, key, value, msg)
        updateSessionConnectorContext(session, connector, msg, session.name || session.id)
        persistSession(session)
        return text
      } catch (err: unknown) {
        return errorMessage(err)
      }
    }
    return 'Usage: /session, /session show, /session set <key> <value>, /session reset'
  }

  if (command.name === 'focus') {
    const subcommand = command.args.trim().toLowerCase()
    if (subcommand === 'clear') {
      session.connectorThreadBinding = null
      session.connectorSessionScope = null
      session.connectorContext = { ...(session.connectorContext || {}), threadId: null }
      persistSession(session)
      return 'Cleared connector thread focus.'
    }
    if (!msg.threadId) {
      return 'Focus can only be set from a threaded or topic-bound message.'
    }
    session.connectorThreadBinding = 'strict'
    session.connectorSessionScope = 'thread'
    session.connectorReplyMode = session.connectorReplyMode || 'all'
    session.connectorContext = { ...(session.connectorContext || {}), threadId: msg.threadId }
    persistSession(session)
    return `Focused this connector session on thread ${msg.threadId}.`
  }

  return 'Unknown command.'
}
