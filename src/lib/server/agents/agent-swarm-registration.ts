import { registerAgent } from '@/lib/swarmfeed-client'
import { patchAgent } from '@/lib/server/agents/agent-repository'
import { log } from '@/lib/server/logger'
import type { Agent } from '@/types'

/**
 * Auto-register an agent on SwarmFeed when enabled but missing API key.
 * Fire-and-forget — called after agent save, patches agent with the returned credentials.
 */
export async function tryAutoRegisterSwarmFeed(agent: Agent): Promise<void> {
  if (!agent.swarmfeedEnabled || agent.swarmfeedApiKey) return

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

  log.info('swarm-registration', `Agent "${agent.name}" registered on SwarmFeed as ${reg.agentId}`)
}
