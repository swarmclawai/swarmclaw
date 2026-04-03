import { NextResponse } from 'next/server'
import { getAgent, listAgents } from '@/lib/server/agents/agent-repository'
import { generateAgentCard } from '@/lib/a2a/agent-card'

export const dynamic = 'force-dynamic'

/**
 * GET /.well-known/agent-card.json?agentId=xxx
 *
 * A2A Agent Card discovery endpoint.
 * If agentId is provided, returns the full card for that agent.
 * Otherwise, returns a directory of all non-disabled agents.
 *
 * Publicly accessible per A2A spec — no auth required for discovery.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  const baseUrl = `${new URL(req.url).origin}`

  if (agentId) {
    const agent = getAgent(agentId)
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    if (agent.disabled) {
      return NextResponse.json({ error: 'Agent is disabled' }, { status: 404 })
    }
    const card = generateAgentCard(agent, baseUrl)
    return NextResponse.json(card)
  }

  // Return directory of all active agents
  const agents = listAgents()
  const directory = Object.values(agents)
    .filter(a => !a.disabled)
    .map(a => ({
      name: a.name,
      description: a.description || `SwarmClaw agent: ${a.name}`,
      agentId: a.id,
      apiEndpoint: `${baseUrl}/api/a2a`,
      cardUrl: `${baseUrl}/api/.well-known/agent-card?agentId=${a.id}`,
    }))

  return NextResponse.json({ agents: directory, protocolVersion: '0.3.0' })
}
