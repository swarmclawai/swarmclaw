import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { log } from '@/lib/server/logger'
import type { ToolBuildContext } from './context'
import type { Agent } from '@/types'

const TAG = 'swarmdock-tool'

const SWARMDOCK_SCHEMA = z.object({
  action: z.enum(['browse_tasks', 'check_status', 'list_skills', 'get_agent_profile']).describe(
    'The SwarmDock marketplace action to perform',
  ),
  taskId: z.string().optional().describe('Task ID for task-specific actions'),
  skillFilter: z.string().optional().describe('Filter tasks by skill (e.g. "data-analysis")'),
  limit: z.number().optional().describe('Number of results to return (default: 10)'),
})

type SwarmDockInput = z.infer<typeof SWARMDOCK_SCHEMA>

async function executeSwarmDock(input: SwarmDockInput, bctx: ToolBuildContext): Promise<string> {
  const agentId = bctx.ctx?.agentId
  if (!agentId) return JSON.stringify({ error: 'No agent context' })

  const agent = getAgent(agentId) as Agent | undefined
  if (!agent) return JSON.stringify({ error: 'Agent not found' })
  if (!agent.swarmdockEnabled) return JSON.stringify({ error: 'SwarmDock is not enabled for this agent' })

  try {
    switch (input.action) {
      case 'browse_tasks': {
        const apiUrl = process.env.SWARMDOCK_API_URL || 'https://swarmdock-api.onrender.com'
        const res = await fetch(`${apiUrl}/api/v1/tasks?limit=${input.limit || 10}${input.skillFilter ? `&skill=${input.skillFilter}` : ''}`)
        if (!res.ok) {
          const text = await res.text().catch(() => 'Unknown error')
          return JSON.stringify({ error: `SwarmDock API error ${res.status}: ${text}` })
        }
        const data = await res.json()
        return JSON.stringify({ tasks: data.tasks || data })
      }

      case 'check_status': {
        return JSON.stringify({
          agent: agent.name,
          swarmdockEnabled: agent.swarmdockEnabled,
          swarmdockAgentId: agent.swarmdockAgentId || null,
          swarmdockDid: agent.swarmdockDid || null,
          listedAt: agent.swarmdockListedAt || null,
          skills: agent.swarmdockSkills || [],
          description: agent.swarmdockDescription || null,
          marketplace: agent.swarmdockMarketplace || null,
        })
      }

      case 'list_skills': {
        return JSON.stringify({
          agentSkills: agent.swarmdockSkills || [],
          description: agent.swarmdockDescription || null,
        })
      }

      case 'get_agent_profile': {
        return JSON.stringify({
          name: agent.name,
          description: agent.swarmdockDescription || agent.description || null,
          skills: agent.swarmdockSkills || [],
          swarmdockAgentId: agent.swarmdockAgentId || null,
          swarmdockDid: agent.swarmdockDid || null,
          walletId: agent.swarmdockWalletId || null,
          marketplace: agent.swarmdockMarketplace || null,
        })
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${input.action}` })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    log.error(TAG, `Action "${input.action}" failed for agent "${agent.name}": ${message}`)
    return JSON.stringify({ error: message })
  }
}

export function buildSwarmDockTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const agentId = bctx.ctx?.agentId
  if (!agentId) return []

  const agent = getAgent(agentId) as Agent | undefined
  if (!agent?.swarmdockEnabled) return []

  return [
    tool(
      async (args) => executeSwarmDock(args as SwarmDockInput, bctx),
      {
        name: 'swarmdock',
        description:
          'Interact with SwarmDock, the AI agent marketplace. ' +
          'Actions: browse_tasks (find available tasks), check_status (check marketplace registration status), ' +
          'list_skills (view configured skills), get_agent_profile (view marketplace profile).',
        schema: SWARMDOCK_SCHEMA,
      },
    ),
  ]
}
