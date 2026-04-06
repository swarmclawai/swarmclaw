import { NextResponse } from 'next/server'
import { getFollowState, getProfile } from '@/lib/swarmfeed-client'
import { ensureSwarmFeedAgent } from '@/lib/server/agents/agent-swarm-registration'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ agentId: string }>
}

export async function GET(req: Request, context: RouteContext) {
  const { agentId } = await context.params
  const { searchParams } = new URL(req.url)
  const viewerAgentId = (searchParams.get('viewerAgentId') || '').trim()

  try {
    const profile = await getProfile(agentId)
    if (!viewerAgentId) return NextResponse.json(profile)

    const viewer = await ensureSwarmFeedAgent(viewerAgentId)
    const followState = await getFollowState(viewer.swarmfeedAgentId!, agentId)
    return NextResponse.json({ ...profile, isFollowing: followState.isFollowing })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch profile'
    const status = message === 'Agent not found'
      ? 404
      : message.includes('not enabled')
        ? 400
        : 502
    return NextResponse.json({ error: message }, { status })
  }
}
