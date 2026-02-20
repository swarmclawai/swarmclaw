import crypto from 'crypto'
import {
  loadConnectors, saveConnectors, loadSessions, saveSessions,
  loadAgents, loadCredentials, decryptKey, loadSettings, loadSkills,
} from '../storage'
import { streamAgentChat } from '../stream-agent-chat'
import type { Connector } from '@/types'
import type { ConnectorInstance, InboundMessage, InboundMedia } from './types'

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
async function getPlatform(platform: string) {
  switch (platform) {
    case 'discord':  return (await import('./discord')).default
    case 'telegram': return (await import('./telegram')).default
    case 'slack':    return (await import('./slack')).default
    case 'whatsapp': return (await import('./whatsapp')).default
    default: throw new Error(`Unknown platform: ${platform}`)
  }
}

function formatMediaLine(media: InboundMedia): string {
  const typeLabel = media.type.toUpperCase()
  const name = media.fileName || media.mimeType || 'attachment'
  const size = media.sizeBytes ? ` (${Math.max(1, Math.round(media.sizeBytes / 1024))} KB)` : ''
  if (media.url) return `- ${typeLabel}: ${name}${size} -> ${media.url}`
  return `- ${typeLabel}: ${name}${size}`
}

function formatInboundUserText(msg: InboundMessage): string {
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

/** Route an inbound message through the assigned agent and return the response */
async function routeMessage(connector: Connector, msg: InboundMessage): Promise<string> {
  if (msg?.channelId) {
    lastInboundChannelByConnector.set(connector.id, msg.channelId)
  }
  const agents = loadAgents()
  const agent = agents[connector.agentId]
  if (!agent) return '[Error] Connector agent not found.'

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
    const id = crypto.randomBytes(4).toString('hex')
    session = {
      id,
      name: sessionKey,
      cwd: process.cwd(),
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
  // Add connector context
  promptParts.push(`\nYou are receiving messages via ${msg.platform}. The user "${msg.senderName}" is messaging from channel "${msg.channelName || msg.channelId}". Respond naturally and conversationally.

## Knowing When Not to Reply
Real conversations have natural pauses — not every message needs a response. Reply with exactly "NO_MESSAGE" (nothing else) to stay silent when replying would feel unnatural or forced.
Stay silent for simple acknowledgments ("okay", "alright", "cool", "got it", "sounds good"), conversation closers ("thanks", "bye", "night", "ttyl"), reactions (emoji, "haha", "lol"), and forwarded content with no question attached.
Always reply when there's a question, task, instruction, emotional sharing, or something genuinely useful to add.
The test: would a thoughtful friend feel compelled to type something back? If not, NO_MESSAGE.`)
  const systemPrompt = promptParts.join('\n\n')

  // Add message to session
  const firstImageUrl = msg.imageUrl || msg.media?.find((m) => m.type === 'image' && m.url)?.url
  const inboundText = formatInboundUserText(msg)
  session.messages.push({
    role: 'user',
    text: inboundText,
    time: Date.now(),
    imageUrl: firstImageUrl || undefined,
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
      fullText = await streamAgentChat({
        session,
        message: msg.text,
        apiKey,
        systemPrompt,
        write: () => {},  // no SSE needed for connectors
        history: session.messages,
      })
      console.log(`[connector] streamAgentChat returned ${fullText.length} chars`)
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
      loadHistory: () => session.messages,
    })
  }

  // If the agent chose NO_MESSAGE, skip saving it to history — the user's message
  // is already recorded, and saving the sentinel would pollute the LLM's context
  if (isNoMessage(fullText)) {
    console.log(`[connector] Agent returned NO_MESSAGE — suppressing outbound reply`)
    return NO_MESSAGE_SENTINEL
  }

  // Save assistant response to session
  if (fullText.trim()) {
    session.messages.push({ role: 'assistant', text: fullText.trim(), time: Date.now() })
    session.lastActiveAt = Date.now()
    const s2 = loadSessions()
    s2[session.id] = session
    saveSessions(s2)
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

  if (!botToken && connector.platform !== 'whatsapp') {
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

    console.log(`[connector] Started ${connector.platform} connector: ${connector.name}`)
  } catch (err: any) {
    connector.status = 'error'
    connector.isEnabled = false
    connector.lastError = err.message
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
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
  if (isNoMessage(params.text) && !params.imageUrl && !params.fileUrl) {
    console.log(`[connector] sendConnectorMessage: NO_MESSAGE — suppressing outbound send`)
    return { connectorId, platform: connector.platform, channelId: params.channelId }
  }

  const result = await instance.sendMessage(params.channelId, params.text, {
    imageUrl: params.imageUrl,
    fileUrl: params.fileUrl,
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
