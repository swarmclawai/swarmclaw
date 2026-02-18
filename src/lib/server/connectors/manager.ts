import crypto from 'crypto'
import {
  loadConnectors, saveConnectors, loadSessions, saveSessions,
  loadAgents, loadCredentials, decryptKey, loadSettings, loadSkills,
} from '../storage'
import { streamAgentChat } from '../stream-agent-chat'
import type { Connector } from '@/types'
import type { ConnectorInstance, InboundMessage } from './types'

/** Map of running connector instances by connector ID */
const running = new Map<string, ConnectorInstance>()

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

/** Route an inbound message through the assigned agent and return the response */
async function routeMessage(connector: Connector, msg: InboundMessage): Promise<string> {
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
  promptParts.push(`\nYou are receiving messages via ${msg.platform}. The user "${msg.senderName}" is messaging from channel "${msg.channelName || msg.channelId}". Respond naturally and conversationally.`)
  const systemPrompt = promptParts.join('\n\n')

  // Add message to session
  session.messages.push({
    role: 'user',
    text: `[${msg.senderName}] ${msg.text}`,
    time: Date.now(),
  })
  session.lastActiveAt = Date.now()
  const s1 = loadSessions()
  s1[session.id] = session
  saveSessions(s1)

  // Stream the response
  let fullText = ''
  const hasTools = session.tools?.length && session.provider !== 'claude-cli'

  if (hasTools) {
    fullText = await streamAgentChat({
      session,
      message: msg.text,
      apiKey,
      systemPrompt,
      write: () => {},  // no SSE needed for connectors
      history: session.messages,
    })
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

/** Start a connector */
export async function startConnector(connectorId: string): Promise<void> {
  if (running.has(connectorId)) {
    throw new Error('Connector is already running')
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
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)

    console.log(`[connector] Started ${connector.platform} connector: ${connector.name}`)
  } catch (err: any) {
    connector.status = 'error'
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

/** Stop all running connectors (for cleanup) */
export async function stopAllConnectors(): Promise<void> {
  for (const [id] of running) {
    await stopConnector(id)
  }
}

/** Auto-start connectors that are marked as enabled */
export async function autoStartConnectors(): Promise<void> {
  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as Connector[]) {
    if (connector.isEnabled) {
      try {
        await startConnector(connector.id)
      } catch (err: any) {
        console.error(`[connector] Failed to auto-start ${connector.name}:`, err.message)
      }
    }
  }
}
