import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import { loadExternalAgents, saveExternalAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { AgentCardSchema } from './types'
import type { AgentCard } from './types'
import type { ExternalAgentRuntime } from '@/types/agent'

const TAG = 'a2a-discovery'

// TTL cache for fetched agent cards (5 minutes)
interface CacheEntry { card: AgentCard; fetchedAt: number }
const cache = hmrSingleton('a2a_discovery_cache', () => new Map<string, CacheEntry>())
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Discover an A2A agent by fetching its agent card from the well-known endpoint.
 * Results are cached for 5 minutes.
 */
export async function discoverA2AAgent(url: string): Promise<AgentCard> {
  const cached = cache.get(url)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.card
  }

  const cardUrl = url.endsWith('/') ? `${url}.well-known/agent-card.json` : `${url}/.well-known/agent-card.json`

  log.info(TAG, `Discovering A2A agent at ${cardUrl}`)

  const response = await fetch(cardUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch agent card from ${cardUrl}: ${response.status} ${response.statusText}`)
  }

  const raw = await response.json()
  const parsed = AgentCardSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid agent card from ${cardUrl}: ${parsed.error.message}`)
  }

  const card = parsed.data
  cache.set(url, { card, fetchedAt: Date.now() })

  return card
}

/**
 * Register a discovered A2A agent in the ExternalAgentRuntime registry.
 * Creates or updates the entry.
 */
export function registerDiscoveredA2AAgent(card: AgentCard, endpoint: string): ExternalAgentRuntime {
  const agents = loadExternalAgents()
  const nowMs = Date.now()

  // Check if already registered by endpoint
  const existing = Object.values(agents).find(a => a.sourceType === 'a2a' && a.endpoint === endpoint)

  const runtime: ExternalAgentRuntime = {
    id: existing?.id ?? genId(8),
    name: card.name,
    sourceType: 'a2a',
    status: 'online',
    transport: 'http',
    endpoint,
    capabilities: card.capabilities.map(c => c.name),
    version: card.version,
    a2aCard: {
      protocolVersion: card.protocolVersion,
      apiEndpoint: card.apiEndpoint,
      capabilities: card.capabilities,
      supportsStreaming: card.supportsStreaming,
      supportsAsync: card.supportsAsync,
    },
    lastSeenAt: nowMs,
    lastHeartbeatAt: nowMs,
    createdAt: existing?.createdAt ?? nowMs,
    updatedAt: nowMs,
  }

  agents[runtime.id] = runtime
  saveExternalAgents(agents)
  notify('external_agents')

  log.info(TAG, `Registered A2A agent: ${card.name} (${runtime.id}) at ${endpoint}`)

  return runtime
}

/**
 * Discover and register an A2A agent in one step.
 */
export async function discoverAndRegisterA2AAgent(url: string): Promise<ExternalAgentRuntime> {
  try {
    const card = await discoverA2AAgent(url)
    return registerDiscoveredA2AAgent(card, card.apiEndpoint || url)
  } catch (err) {
    log.error(TAG, `Failed to discover A2A agent at ${url}: ${errorMessage(err)}`)
    throw err
  }
}

/**
 * List all known A2A external agents.
 */
export function listA2AAgents(): ExternalAgentRuntime[] {
  const agents = loadExternalAgents()
  return Object.values(agents).filter(a => a.sourceType === 'a2a')
}

/**
 * Clear the discovery cache.
 */
export function clearDiscoveryCache(): void {
  cache.clear()
}
