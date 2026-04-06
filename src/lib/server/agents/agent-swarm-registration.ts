import { registerAgent } from '@/lib/swarmfeed-client'
import { getAgent, patchAgent } from '@/lib/server/agents/agent-repository'
import { log } from '@/lib/server/logger'
import type { Agent } from '@/types'

type EnsureSwarmFeedAgentOptions = {
  requireEnabled?: boolean
}

export async function ensureSwarmFeedAgent(
  agentId: string,
  options: EnsureSwarmFeedAgentOptions = {},
): Promise<Agent> {
  const agent = getAgent(agentId) as Agent | undefined
  if (!agent) throw new Error('Agent not found')
  if (options.requireEnabled !== false && !agent.swarmfeedEnabled) {
    throw new Error('SwarmFeed is not enabled for this agent')
  }
  if (agent.swarmfeedApiKey && agent.swarmfeedAgentId) return agent

  log.info('swarm-registration', `Auto-registering agent "${agent.name}" on SwarmFeed`)
  const reg = await registerAgent({
    name: agent.name,
    description: agent.description || agent.swarmfeedBio || `${agent.name} agent on SwarmClaw`,
    framework: 'swarmclaw',
    model: agent.model,
    avatar: agent.avatarUrl || undefined,
    bio: agent.swarmfeedBio || undefined,
  })

  patchAgent(agent.id, (current) => {
    if (!current) return null
    return {
      ...current,
      swarmfeedApiKey: reg.apiKey,
      swarmfeedAgentId: reg.agentId,
      swarmfeedJoinedAt: current.swarmfeedJoinedAt ?? Date.now(),
      updatedAt: Date.now(),
    }
  })

  const updated = getAgent(agentId) as Agent | undefined
  if (!updated?.swarmfeedApiKey || !updated.swarmfeedAgentId) {
    throw new Error('Registration succeeded but credentials were not saved')
  }

  log.info('swarm-registration', `Agent "${updated.name}" registered on SwarmFeed as ${updated.swarmfeedAgentId}`)
  return updated
}

/**
 * Auto-register an agent on SwarmFeed when enabled but missing API key.
 * Fire-and-forget — called after agent save, patches agent with the returned credentials.
 */
export async function tryAutoRegisterSwarmFeed(agent: Agent): Promise<void> {
  if (!agent.swarmfeedEnabled || (agent.swarmfeedApiKey && agent.swarmfeedAgentId)) return
  await ensureSwarmFeedAgent(agent.id)
}
