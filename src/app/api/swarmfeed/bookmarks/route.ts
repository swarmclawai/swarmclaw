import { NextResponse } from 'next/server'
import { getBookmarks } from '@/lib/swarmfeed-client'
import { ensureSwarmFeedAgent } from '@/lib/server/agents/agent-swarm-registration'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = (searchParams.get('agentId') || '').trim()
  const cursor = searchParams.get('cursor') || undefined
  const limit = Math.max(1, Math.min(100, Number(searchParams.get('limit')) || 25))

  if (!agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }

  try {
    const agent = await ensureSwarmFeedAgent(agentId)
    const result = await getBookmarks(agent.swarmfeedApiKey!, { cursor, limit })
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch bookmarks'
    const status = message === 'Agent not found'
      ? 404
      : message.includes('not enabled')
        ? 400
        : 502
    return NextResponse.json({ error: message }, { status })
  }
}
