import { genId } from '@/lib/id'
import {
  loadConnectors, saveConnectors, loadSessions, saveSessions,
  loadAgents, loadCredentials, decryptKey, loadSettings, loadSkills,
} from '../storage'
import { WORKSPACE_DIR } from '../data-dir'
import { streamAgentChat } from '../stream-agent-chat'
import { notify } from '../ws-hub'
import { logExecution } from '../execution-log'
import type { Connector } from '@/types'
import type { ConnectorInstance, InboundMessage, InboundMedia } from './types'
import {
  addAllowedSender,
  approvePairingCode,
  createOrTouchPairingRequest,
  isSenderAllowed,
  listPendingPairingRequests,
  listStoredAllowedSenders,
  parseAllowFromCsv,
  parsePairingPolicy,
  type PairingPolicy,
} from './pairing'

/** Sentinel value agents return when no outbound reply should be sent */
export const NO_MESSAGE_SENTINEL = 'NO_MESSAGE'

/** Check if an agent response is the NO_MESSAGE sentinel (case-insensitive, trimmed) */
export function isNoMessage(text: string): boolean {
  return text.trim().toUpperCase() === NO_MESSAGE_SENTINEL
}

/** Map of running connector instances by connector ID.
 *  Stored on globalThis to survive HMR reloads in dev mode —
 *  prevents duplicate sockets fighting for the same WhatsApp session. */
const globalKey = '__swarmclaw_running_connectors__' as const
const running: Map<string, ConnectorInstance> =
  (globalThis as any)[globalKey] ?? ((globalThis as any)[globalKey] = new Map<string, ConnectorInstance>())

/** Most recent inbound channel per connector (used for proactive replies/default outbound target) */
const lastInboundKey = '__swarmclaw_connector_last_inbound__' as const
const lastInboundChannelByConnector: Map<string, string> =
  (globalThis as any)[lastInboundKey] ?? ((globalThis as any)[lastInboundKey] = new Map<string, string>())

/** Per-connector lock to prevent concurrent start/stop operations */
const lockKey = '__swarmclaw_connector_locks__' as const
const locks: Map<string, Promise<void>> =
  (globalThis as any)[lockKey] ?? ((globalThis as any)[lockKey] = new Map<string, Promise<void>>())

/** Get platform implementation lazily */
export async function getPlatform(platform: string) {
  switch (platform) {
    case 'discord':  return (await import('./discord')).default
    case 'telegram': return (await import('./telegram')).default
    case 'slack':    return (await import('./slack')).default
    case 'whatsapp': return (await import('./whatsapp')).default
    case 'openclaw': return (await import('./openclaw')).default
    case 'bluebubbles': return (await import('./bluebubbles')).default
    case 'signal':    return (await import('./signal')).default
    case 'teams':     return (await import('./teams')).default
    case 'googlechat': return (await import('./googlechat')).default
    case 'matrix':    return (await import('./matrix')).default
    default: throw new Error(`Unknown platform: ${platform}`)
  }
}

export function formatMediaLine(media: InboundMedia): string {
  const typeLabel = media.type.toUpperCase()
  const name = media.fileName || media.mimeType || 'attachment'
  const size = media.sizeBytes ? ` (${Math.max(1, Math.round(media.sizeBytes / 1024))} KB)` : ''
  if (media.url) return `- ${typeLabel}: ${name}${size} -> ${media.url}`
  return `- ${typeLabel}: ${name}${size}`
}

export function formatInboundUserText(msg: InboundMessage): string {
  const baseText = (msg.text || '').trim()
  const lines: string[] = []
  if (baseText) lines.push(`[${msg.senderName}] ${baseText}`)
  else lines.push(`[${msg.senderName}]`)

  if (Array.isArray(msg.media) && msg.media.length > 0) {
    lines.push('')
    lines.push('Media received:')
    const preview = msg.media.slice(0, 6)
    for (const media of preview) lines.push(formatMediaLine(media))
    if (msg.media.length > preview.length) {
      lines.push(`- ...and ${msg.media.length - preview.length} more attachment(s)`)
    }
  }

  return lines.join('\n').trim()
}

type ConnectorCommandName = 'help' | 'status' | 'new' | 'reset' | 'compact' | 'think' | 'pair'

interface ParsedConnectorCommand {
  name: ConnectorCommandName
  args: string
}

function parseConnectorCommand(text: string): ParsedConnectorCommand | null {
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
      return { name, args } as ParsedConnectorCommand
    default:
      return null
  }
}

function pushSessionMessage(session: any, role: 'user' | 'assistant', text: string): void {
  if (!text.trim()) return
  if (!Array.isArray(session.messages)) session.messages = []
  session.messages.push({ role, text: text.trim(), time: Date.now() })
  session.lastActiveAt = Date.now()
}

function persistSession(session: any): void {
  const sessions = loadSessions()
  sessions[session.id] = session
  saveSessions(sessions)
  notify(`messages:${session.id}`)
}

function summarizeForCompaction(messages: Array<{ role?: string; text?: string }>): string {
  const preview = messages
    .slice(-8)
    .map((m, i) => {
      const role = (m.role || 'unknown').toUpperCase()
      const body = (m.text || '').replace(/\s+/g, ' ').trim()
      const clipped = body.length > 180 ? `${body.slice(0, 177)}...` : body
      return `${i + 1}. [${role}] ${clipped || '(no text)'}`
    })
  if (!preview.length) return 'No earlier messages to summarize.'
  return preview.join('\n')
}

function resolvePairingAccess(connector: Connector, msg: InboundMessage): {
  policy: PairingPolicy
  configAllowFrom: string[]
  isAllowed: boolean
  hasAnyApprover: boolean
} {
  const policy = parsePairingPolicy(connector.config?.dmPolicy, 'open')
  const configAllowFrom = parseAllowFromCsv(connector.config?.allowFrom)
  const stored = listStoredAllowedSenders(connector.id)
  const isAllowed = isSenderAllowed({
    connectorId: connector.id,
    senderId: msg.senderId,
    configAllowFrom,
  })
  return {
    policy,
    configAllowFrom,
    isAllowed,
    hasAnyApprover: (configAllowFrom.length + stored.length) > 0,
  }
}

async function handlePairCommand(params: {
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

function enforceInboundAccessPolicy(connector: Connector, msg: InboundMessage): string | null {
  if (msg.isGroup) return null
  const { policy, configAllowFrom, isAllowed } = resolvePairingAccess(connector, msg)
  const storedAllowFrom = listStoredAllowedSenders(connector.id)
  if (policy === 'open') return null

  if (policy === 'disabled') return NO_MESSAGE_SENTINEL
  if (isAllowed) return null

  if (policy === 'allowlist') {
    if (!configAllowFrom.length && !storedAllowFrom.length) {
      return 'This connector is set to allowlist mode, but no allowFrom entries are configured.'
    }
    return 'You are not authorized for this connector. Ask an approved user to add your sender ID via /pair allow <senderId>.'
  }

  if (policy === 'pairing') {
    const request = createOrTouchPairingRequest({
      connectorId: connector.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      channelId: msg.channelId,
    })
    return [
      'Pairing is required before this connector will respond.',
      `Your pairing code: ${request.code}`,
      'Ask an approved sender to run /pair approve <code>.',
      'Tip: if this is first-time setup with no approvals yet, run /pair approve <code> from this chat to bootstrap.',
    ].join('\n')
  }

  return null
}

async function handleConnectorCommand(params: {
  command: ParsedConnectorCommand
  connector: Connector
  session: any
  msg: InboundMessage
  agentName: string
}): Promise<string> {
  const { command, connector, session, msg, agentName } = params
  const inboundText = formatInboundUserText(msg)

  if (command.name === 'help') {
    const text = [
      'Connector commands:',
      '/status — Show active session status',
      '/new or /reset — Clear this connector conversation thread',
      '/compact [keepLastN] — Summarize older history and keep recent messages (default 10)',
      '/think <minimal|low|medium|high> — Set connector thread reasoning guidance',
      '/pair — Pairing/access controls (status, request, list, approve, allow)',
      '/help — Show this list',
    ].join('\n')
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'status') {
    const all = Array.isArray(session.messages) ? session.messages : []
    const userCount = all.filter((m: any) => m?.role === 'user').length
    const assistantCount = all.filter((m: any) => m?.role === 'assistant').length
    const toolsCount = Array.isArray(session.tools) ? session.tools.length : 0
    const statusText = [
      `Status for ${connector.platform} / ${connector.name}:`,
      `- Agent: ${agentName}`,
      `- Session: ${session.id}`,
      `- Model: ${session.provider}/${session.model}`,
      `- Messages: ${all.length} (${userCount} user, ${assistantCount} assistant)`,
      `- Tools enabled: ${toolsCount}`,
      `- Channel: ${msg.channelName || msg.channelId}`,
      `- Last active: ${new Date(session.lastActiveAt || session.createdAt || Date.now()).toLocaleString()}`,
    ].join('\n')
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', statusText)
    persistSession(session)
    return statusText
  }

  if (command.name === 'new' || command.name === 'reset') {
    const cleared = Array.isArray(session.messages) ? session.messages.length : 0
    session.messages = []
    session.claudeSessionId = null
    session.codexThreadId = null
    session.opencodeSessionId = null
    session.delegateResumeIds = { claudeCode: null, codex: null, opencode: null }
    session.lastActiveAt = Date.now()
    persistSession(session)
    return `Reset complete for ${connector.platform} channel thread. Cleared ${cleared} message(s).`
  }

  if (command.name === 'compact') {
    const keepParsed = Number.parseInt(command.args, 10)
    const keepLastN = Number.isFinite(keepParsed) ? Math.max(4, Math.min(50, keepParsed)) : 10
    const history = Array.isArray(session.messages) ? session.messages : []
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
    session.messages = [summaryMessage, ...recentMessages]
    session.lastActiveAt = Date.now()
    const text = `Compacted ${oldMessages.length} message(s). Kept ${recentMessages.length} recent message(s) plus a summary.`
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'think') {
    const requested = command.args.trim().toLowerCase()
    const allowed = new Set(['minimal', 'low', 'medium', 'high'])
    if (!requested) {
      const current = typeof session.connectorThinkLevel === 'string' && allowed.has(session.connectorThinkLevel)
        ? session.connectorThinkLevel
        : 'medium'
      const text = `Current /think level: ${current}. Usage: /think <minimal|low|medium|high>.`
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    if (!allowed.has(requested)) {
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

  return 'Unknown command.'
}

/** Route an inbound message through the assigned agent and return the response */
async function routeMessage(connector: Connector, msg: InboundMessage): Promise<string> {
  if (msg?.channelId) {
    lastInboundChannelByConnector.set(connector.id, msg.channelId)
  }

  const agents = loadAgents()
  const effectiveAgentId = msg.agentIdOverride || connector.agentId
  const agent = agents[effectiveAgentId]
  if (!agent) return '[Error] Connector agent not found.'

  // Log connector trigger
  const triggerSessionKey = `connector:${connector.id}:${msg.channelId}`
  const allSessions = loadSessions()
  const existingSession = Object.values(allSessions).find((s: any) => s.name === triggerSessionKey)
  if (existingSession) {
    logExecution(existingSession.id, 'trigger', `${msg.platform} message from ${msg.senderName}`, {
      agentId: agent.id,
      detail: {
        source: 'connector',
        platform: msg.platform,
        connectorId: connector.id,
        channelId: msg.channelId,
        senderName: msg.senderName,
        messagePreview: (msg.text || '').slice(0, 200),
        hasMedia: !!(msg.media?.length || msg.imageUrl),
      },
    })
  }

  // Resolve API key for the agent's provider
  let apiKey: string | null = null
  if (agent.credentialId) {
    const creds = loadCredentials()
    const cred = creds[agent.credentialId]
    if (cred?.encryptedKey) {
      try { apiKey = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
    }
  }

  // Find or create a session keyed by platform + channel
  const sessionKey = `connector:${connector.id}:${msg.channelId}`
  const sessions = loadSessions()
  let session = Object.values(sessions).find((s: any) => s.name === sessionKey)
  if (!session) {
    const id = genId()
    session = {
      id,
      name: sessionKey,
      cwd: WORKSPACE_DIR,
      user: 'connector',
      provider: agent.provider === 'claude-cli' ? 'anthropic' : agent.provider,
      model: agent.model,
      credentialId: agent.credentialId || null,
      apiEndpoint: agent.apiEndpoint || null,
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: {
        claudeCode: null,
        codex: null,
        opencode: null,
      },
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human' as const,
      agentId: agent.id,
      tools: agent.tools || [],
    }
    sessions[id] = session
    saveSessions(sessions)
  }

  const parsedCommand = parseConnectorCommand(msg.text || '')
  if (parsedCommand?.name === 'pair') {
    const commandResult = await handlePairCommand({
      connector,
      msg,
      args: parsedCommand.args,
    })
    logExecution(session.id, 'decision', 'Connector pair command handled', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        command: 'pair',
        args: parsedCommand.args || null,
      },
    })
    return commandResult
  }

  const accessPolicyResult = enforceInboundAccessPolicy(connector, msg)
  if (accessPolicyResult) {
    logExecution(session.id, 'decision', 'Connector inbound blocked by access policy', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
        policy: parsePairingPolicy(connector.config?.dmPolicy, 'open'),
      },
    })
    return accessPolicyResult
  }

  if (parsedCommand) {
    const commandResult = await handleConnectorCommand({
      command: parsedCommand,
      connector,
      session,
      msg,
      agentName: agent.name,
    })
    logExecution(session.id, 'decision', `Connector command handled: /${parsedCommand.name}`, {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        command: parsedCommand.name,
        args: parsedCommand.args || null,
      },
    })
    return commandResult
  }

  // Build system prompt: [userPrompt] \n\n [soul] \n\n [systemPrompt]
  const settings = loadSettings()
  const promptParts: string[] = []
  if (settings.userPrompt) promptParts.push(settings.userPrompt)
  if (agent.soul) promptParts.push(agent.soul)
  if (agent.systemPrompt) promptParts.push(agent.systemPrompt)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) promptParts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  const thinkLevel = typeof session.connectorThinkLevel === 'string'
    ? session.connectorThinkLevel.trim().toLowerCase()
    : ''
  if (thinkLevel) {
    promptParts.push(`Connector thinking guidance: ${thinkLevel}. Keep responses concise and useful for chat.`)
  }
  // Add connector context
  promptParts.push(`\nYou are receiving messages via ${msg.platform}. The user "${msg.senderName}" is messaging from channel "${msg.channelName || msg.channelId}". Respond naturally and conversationally.

## Knowing When Not to Reply
Real conversations have natural pauses — not every message needs a response. Reply with exactly "NO_MESSAGE" (nothing else) to stay silent when replying would feel unnatural or forced.
Stay silent for simple acknowledgments ("okay", "alright", "cool", "got it", "sounds good"), conversation closers ("thanks", "bye", "night", "ttyl"), reactions (emoji, "haha", "lol"), and forwarded content with no question attached.
Always reply when there's a question, task, instruction, emotional sharing, or something genuinely useful to add.
The test: would a thoughtful friend feel compelled to type something back? If not, NO_MESSAGE.`)
  const systemPrompt = promptParts.join('\n\n')

  // Add message to session
  const firstImage = msg.media?.find((m) => m.type === 'image')
  const firstImageUrl = msg.imageUrl || (firstImage?.url) || undefined
  const firstImagePath = firstImage?.localPath || undefined
  const inboundText = formatInboundUserText(msg)
  session.messages.push({
    role: 'user',
    text: inboundText,
    time: Date.now(),
    imageUrl: firstImageUrl,
    imagePath: firstImagePath,
  })
  session.lastActiveAt = Date.now()
  const s1 = loadSessions()
  s1[session.id] = session
  saveSessions(s1)

  // Stream the response
  let fullText = ''
  const hasTools = session.tools?.length && session.provider !== 'claude-cli'
  console.log(`[connector] Routing message to agent "${agent.name}" (${agent.provider}/${agent.model}), hasTools=${!!hasTools}`)

  if (hasTools) {
    try {
      const result = await streamAgentChat({
        session,
        message: msg.text,
        imagePath: firstImagePath,
        apiKey,
        systemPrompt,
        write: () => {},  // no SSE needed for connectors
        history: session.messages.slice(-20),
      })
      // Use finalResponse for connectors — strips intermediate planning/tool-use text
      fullText = result.finalResponse
      console.log(`[connector] streamAgentChat returned ${result.fullText.length} chars total, ${fullText.length} chars final`)
    } catch (err: any) {
      console.error(`[connector] streamAgentChat error:`, err.message || err)
      return `[Error] ${err.message}`
    }
  } else {
    // Use the provider directly
    const { getProvider } = await import('../../providers')
    const provider = getProvider(session.provider)
    if (!provider) return '[Error] Provider not found.'

    await provider.handler.streamChat({
      session,
      message: msg.text,
      imagePath: firstImagePath,
      apiKey,
      systemPrompt,
      write: (data: string) => {
        if (data.startsWith('data: ')) {
          try {
            const event = JSON.parse(data.slice(6))
            if (event.t === 'd') fullText += event.text || ''
            else if (event.t === 'r') fullText = event.text || ''
          } catch { /* ignore */ }
        }
      },
      active: new Map(),
      loadHistory: () => session.messages.slice(-20),
    })
  }

  // If the agent chose NO_MESSAGE, skip saving it to history — the user's message
  // is already recorded, and saving the sentinel would pollute the LLM's context
  if (isNoMessage(fullText)) {
    console.log(`[connector] Agent returned NO_MESSAGE — suppressing outbound reply`)
    logExecution(session.id, 'decision', 'Agent suppressed outbound (NO_MESSAGE)', {
      agentId: agent.id,
      detail: { platform: msg.platform, channelId: msg.channelId },
    })
    return NO_MESSAGE_SENTINEL
  }

  // Log outbound message
  logExecution(session.id, 'outbound', `Reply sent via ${msg.platform}`, {
    agentId: agent.id,
    detail: {
      platform: msg.platform,
      channelId: msg.channelId,
      recipientName: msg.senderName,
      responsePreview: fullText.slice(0, 500),
      responseLength: fullText.length,
    },
  })

  // Save assistant response to session
  if (fullText.trim()) {
    session.messages.push({ role: 'assistant', text: fullText.trim(), time: Date.now() })
    session.lastActiveAt = Date.now()
    const s2 = loadSessions()
    s2[session.id] = session
    saveSessions(s2)
    notify(`messages:${session.id}`)
  }

  return fullText || '(no response)'
}

/** Start a connector (serialized per ID to prevent concurrent start/stop races) */
export async function startConnector(connectorId: string): Promise<void> {
  // Wait for any pending operation on this connector to finish (with timeout)
  const pending = locks.get(connectorId)
  if (pending) {
    await Promise.race([pending, new Promise(r => setTimeout(r, 15_000))]).catch(() => {})
    locks.delete(connectorId)
  }

  const op = withTimeout(_startConnectorImpl(connectorId), 30_000, 'Connector start timed out')
  locks.set(connectorId, op)
  try { await op } finally {
    if (locks.get(connectorId) === op) locks.delete(connectorId)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function _startConnectorImpl(connectorId: string): Promise<void> {
  // If already running, stop it first (handles stale entries)
  if (running.has(connectorId)) {
    try {
      const existing = running.get(connectorId)
      await existing?.stop()
    } catch { /* ignore cleanup errors */ }
    running.delete(connectorId)
  }

  const connectors = loadConnectors()
  const connector = connectors[connectorId] as Connector | undefined
  if (!connector) throw new Error('Connector not found')

  // Resolve bot token from credential
  let botToken = ''
  if (connector.credentialId) {
    const creds = loadCredentials()
    const cred = creds[connector.credentialId]
    if (cred?.encryptedKey) {
      try { botToken = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
    }
  }
  // Also check config for inline token (some platforms)
  if (!botToken && connector.config.botToken) {
    botToken = connector.config.botToken
  }
  if (!botToken && connector.platform === 'bluebubbles' && connector.config.password) {
    botToken = connector.config.password
  }

  if (!botToken && connector.platform !== 'whatsapp' && connector.platform !== 'openclaw' && connector.platform !== 'signal') {
    throw new Error('No bot token configured')
  }

  const platform = await getPlatform(connector.platform)

  try {
    const instance = await platform.start(connector, botToken, (msg) => routeMessage(connector, msg))
    running.set(connectorId, instance)

    // Update status in storage
    connector.status = 'running'
    connector.isEnabled = true
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')

    console.log(`[connector] Started ${connector.platform} connector: ${connector.name}`)
  } catch (err: any) {
    connector.status = 'error'
    connector.isEnabled = false
    connector.lastError = err.message
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
    throw err
  }
}

/** Stop a connector */
export async function stopConnector(connectorId: string): Promise<void> {
  const instance = running.get(connectorId)
  if (instance) {
    await instance.stop()
    running.delete(connectorId)
  }

  const connectors = loadConnectors()
  const connector = connectors[connectorId]
  if (connector) {
    connector.status = 'stopped'
    connector.isEnabled = false
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
  }

  console.log(`[connector] Stopped connector: ${connectorId}`)
}

/** Get the runtime status of a connector */
export function getConnectorStatus(connectorId: string): 'running' | 'stopped' {
  return running.has(connectorId) ? 'running' : 'stopped'
}

/** Get the QR code data URL for a WhatsApp connector (null if not available) */
export function getConnectorQR(connectorId: string): string | null {
  const instance = running.get(connectorId)
  return instance?.qrDataUrl ?? null
}

/** Check if a WhatsApp connector has authenticated (paired) */
export function isConnectorAuthenticated(connectorId: string): boolean {
  const instance = running.get(connectorId)
  if (!instance) return false
  return instance.authenticated === true
}

/** Check if a WhatsApp connector has stored credentials */
export function hasConnectorCredentials(connectorId: string): boolean {
  const instance = running.get(connectorId)
  if (!instance) return false
  return instance.hasCredentials === true
}

/** Clear WhatsApp auth state and restart connector for fresh QR pairing */
export async function repairConnector(connectorId: string): Promise<void> {
  // Stop existing instance
  const instance = running.get(connectorId)
  if (instance) {
    await instance.stop()
    running.delete(connectorId)
  }

  // Clear auth directory
  const { clearAuthDir } = await import('./whatsapp')
  clearAuthDir(connectorId)

  // Restart the connector — will get fresh QR
  await startConnector(connectorId)
}

/** Stop all running connectors (for cleanup) */
export async function stopAllConnectors(): Promise<void> {
  for (const [id] of running) {
    await stopConnector(id)
  }
}

/** Auto-start connectors that are marked as enabled (skips already-running ones) */
export async function autoStartConnectors(): Promise<void> {
  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as Connector[]) {
    if (connector.isEnabled && !running.has(connector.id)) {
      try {
        console.log(`[connector] Auto-starting ${connector.platform} connector: ${connector.name}`)
        await startConnector(connector.id)
      } catch (err: any) {
        console.error(`[connector] Failed to auto-start ${connector.name}:`, err.message)
      }
    }
  }
}

/** List connector IDs that are currently running (optionally by platform) */
export function listRunningConnectors(platform?: string): Array<{
  id: string
  name: string
  platform: string
  supportsSend: boolean
  configuredTargets: string[]
  recentChannelId: string | null
}> {
  const connectors = loadConnectors()
  const out: Array<{
    id: string
    name: string
    platform: string
    supportsSend: boolean
    configuredTargets: string[]
    recentChannelId: string | null
  }> = []

  for (const [id, instance] of running.entries()) {
    const connector = connectors[id] as Connector | undefined
    if (!connector) continue
    if (platform && connector.platform !== platform) continue
    const configuredTargets: string[] = []
    if (connector.platform === 'whatsapp') {
      const outboundJid = connector.config?.outboundJid?.trim()
      if (outboundJid) configuredTargets.push(outboundJid)
      const allowed = connector.config?.allowedJids?.split(',').map((s) => s.trim()).filter(Boolean) || []
      configuredTargets.push(...allowed)
    } else if (connector.platform === 'bluebubbles') {
      const outbound = connector.config?.outboundTarget?.trim()
      if (outbound) configuredTargets.push(outbound)
      const allowed = connector.config?.allowFrom?.split(',').map((s) => s.trim()).filter(Boolean) || []
      configuredTargets.push(...allowed)
    }
    out.push({
      id,
      name: connector.name,
      platform: connector.platform,
      supportsSend: typeof instance.sendMessage === 'function',
      configuredTargets: Array.from(new Set(configuredTargets)),
      recentChannelId: lastInboundChannelByConnector.get(id) || null,
    })
  }

  return out
}

/** Get the most recent inbound channel id seen for a connector */
export function getConnectorRecentChannelId(connectorId: string): string | null {
  return lastInboundChannelByConnector.get(connectorId) || null
}

/** Get a running connector instance (internal use for rich messaging). */
export function getRunningInstance(connectorId: string): ConnectorInstance | undefined {
  return running.get(connectorId)
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
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
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

  const instance = running.get(connectorId)
  if (!instance) {
    throw new Error(`Connector "${connectorId}" is not running.`)
  }
  if (typeof instance.sendMessage !== 'function') {
    throw new Error(`Connector "${connector.name}" (${connector.platform}) does not support outbound sends.`)
  }

  // Apply NO_MESSAGE filter at the delivery layer so all outbound paths respect it
  if (isNoMessage(params.text) && !params.imageUrl && !params.fileUrl && !params.mediaPath) {
    console.log(`[connector] sendConnectorMessage: NO_MESSAGE — suppressing outbound send`)
    return { connectorId, platform: connector.platform, channelId: params.channelId }
  }

  const result = await instance.sendMessage(params.channelId, params.text, {
    imageUrl: params.imageUrl,
    fileUrl: params.fileUrl,
    mediaPath: params.mediaPath,
    mimeType: params.mimeType,
    fileName: params.fileName,
    caption: params.caption,
  })
  return {
    connectorId,
    platform: connector.platform,
    channelId: params.channelId,
    messageId: result?.messageId,
  }
}
