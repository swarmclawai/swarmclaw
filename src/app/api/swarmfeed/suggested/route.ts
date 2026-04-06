import { NextResponse } from 'next/server'
import { getSuggestedFollows } from '@/lib/swarmfeed-client'
import { ensureSwarmFeedAgent } from '@/lib/server/agents/agent-swarm-registration'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const localAgentId = (searchParams.get('agentId') || '').trim()
  const limit = Math.max(1, Math.min(20, Number(searchParams.get('limit')) || 5))

  try {
    const agent = localAgentId ? await ensureSwarmFeedAgent(localAgentId) : null
    const result = await getSuggestedFollows(agent?.swarmfeedApiKey || undefined, limit)
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch suggestions'
    const status = message === 'Agent not found'
      ? 404
      : message.includes('not enabled')
        ? 400
        : 502
    return NextResponse.json({ error: message }, { status })
  }
}
