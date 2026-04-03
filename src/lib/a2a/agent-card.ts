import type { Agent } from '@/types/agent'
import type { AgentCard } from './types'

const A2A_PROTOCOL_VERSION = '0.3.0'
const SWARMCLAW_VERSION = '1.0.0'

/**
 * Generate an A2A Agent Card from a SwarmClaw agent.
 * Ref: https://a2a-protocol.org/v0.3.0/specification/#agent-card
 */
export function generateAgentCard(agent: Agent, baseUrl: string): AgentCard {
  return {
    name: agent.name,
    description: agent.description || `SwarmClaw agent: ${agent.name}`,
    version: SWARMCLAW_VERSION,
    protocolVersion: A2A_PROTOCOL_VERSION,
    apiEndpoint: `${baseUrl}/api/a2a`,

    capabilities: [
      {
        name: 'task_execution',
        methods: ['executeTask', 'getStatus', 'cancelTask'],
        description: 'Execute tasks and manage task lifecycle',
      },
      {
        name: 'discovery',
        methods: ['discoverAgents'],
        description: 'Discover available A2A agents',
      },
      ...(agent.delegationEnabled ? [{
        name: 'delegation',
        methods: ['executeTask'],
        description: 'Delegate work to other agents',
      }] : []),
    ],

    skills: (agent.capabilities ?? []).map(cap => ({
      name: cap,
      description: `Agent capability: ${cap}`,
    })),

    authMethods: ['api_key'],
    supportsStreaming: true,
    supportsAsync: true,

    rateLimit: {
      requestsPerMinute: 60,
      maxConcurrentRequests: 10,
    },

    extensions: [{
      name: 'swarmclaw',
      version: SWARMCLAW_VERSION,
    }],

    tags: [
      ...(agent.capabilities ?? []),
      'swarmclaw',
    ],
  }
}
