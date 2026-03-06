import { getProvider } from '@/lib/providers'
import type { Agent } from '@/types'
import { resolveAgentApiEndpoint, resolveApiKey } from './chatroom-helpers'
import { isProviderCoolingDown } from './provider-health'

export interface ChatroomAgentHealthSkip {
  agentId: string
  reason: string
}

export interface ChatroomAgentHealthResult {
  healthyAgentIds: string[]
  skipped: ChatroomAgentHealthSkip[]
}

/**
 * Filter chatroom participants to agents that are currently executable.
 * This should never enforce model diversity rules; it only gates hard runtime blockers.
 */
export function filterHealthyChatroomAgents(
  agentIds: string[],
  agents: Record<string, Agent>,
): ChatroomAgentHealthResult {
  const healthyAgentIds: string[] = []
  const skipped: ChatroomAgentHealthSkip[] = []

  for (const agentId of agentIds) {
    const agent = agents[agentId]
    if (!agent) {
      skipped.push({ agentId, reason: 'agent_not_found' })
      continue
    }

    if (isProviderCoolingDown(agent.provider)) {
      skipped.push({ agentId, reason: `provider_cooling_down:${agent.provider}` })
      continue
    }

    const providerInfo = getProvider(agent.provider)
    if (!providerInfo) {
      skipped.push({ agentId, reason: `provider_not_configured:${agent.provider}` })
      continue
    }

    const apiKey = resolveApiKey(agent.credentialId)
    if (providerInfo.requiresApiKey && !apiKey) {
      skipped.push({ agentId, reason: 'missing_api_credentials' })
      continue
    }
    if (providerInfo.requiresEndpoint && !resolveAgentApiEndpoint(agent)) {
      skipped.push({ agentId, reason: 'missing_api_endpoint' })
      continue
    }

    healthyAgentIds.push(agentId)
  }

  return { healthyAgentIds, skipped }
}
