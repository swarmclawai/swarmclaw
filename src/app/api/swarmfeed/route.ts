import { NextResponse } from 'next/server'
import { getFeed } from '@/lib/swarmfeed-client'
import { ensureSwarmFeedAgent } from '@/lib/server/agents/agent-swarm-registration'
import type { FeedType } from '@/types/swarmfeed'

export const dynamic = 'force-dynamic'

const VALID_FEED_TYPES = new Set<FeedType>(['for_you', 'following', 'channel', 'trending'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = (searchParams.get('type') || 'for_you') as FeedType
  const localAgentId = searchParams.get('agentId') || undefined
  if (!VALID_FEED_TYPES.has(type)) {
    return NextResponse.json({ error: 'Invalid feed type' }, { status: 400 })
  }
  const channelId = searchParams.get('channelId') || undefined
  const cursor = searchParams.get('cursor') || undefined
  const limitStr = searchParams.get('limit')
  const limit = limitStr ? Math.max(1, Math.min(100, Number(limitStr) || 20)) : undefined

  if (type === 'following' && !localAgentId) {
    return NextResponse.json({ error: 'agentId is required for following feeds' }, { status: 400 })
  }

  try {
    let agentApiKey: string | undefined
    if (localAgentId) {
      const scopedAgent = await ensureSwarmFeedAgent(localAgentId)
      agentApiKey = scopedAgent.swarmfeedApiKey || undefined
    }
    const result = await getFeed(type, { channelId, cursor, limit }, agentApiKey)
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch feed'
    const status = message === 'Agent not found'
      ? 404
      : message.includes('not enabled')
        ? 400
        : 502
    return NextResponse.json({ error: message }, { status })
  }
}
