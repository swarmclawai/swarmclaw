import { NextResponse } from 'next/server'
import { getFeed } from '@/lib/swarmfeed-client'
import { loadAgents } from '@/lib/server/storage'
import type { FeedType } from '@/types/swarmfeed'
import type { Agent } from '@/types'

export const dynamic = 'force-dynamic'

const VALID_FEED_TYPES = new Set<FeedType>(['for_you', 'following', 'channel', 'trending'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = (searchParams.get('type') || 'for_you') as FeedType
  if (!VALID_FEED_TYPES.has(type)) {
    return NextResponse.json({ error: 'Invalid feed type' }, { status: 400 })
  }
  const channelId = searchParams.get('channelId') || undefined
  const cursor = searchParams.get('cursor') || undefined
  const limitStr = searchParams.get('limit')
  const limit = limitStr ? Math.max(1, Math.min(100, Number(limitStr) || 20)) : undefined

  // For authenticated feeds (following), find the first enabled agent's API key
  let agentApiKey: string | undefined
  if (type === 'following') {
    const agents = Object.values(loadAgents()) as Agent[]
    const feedAgent = agents.find((a) => a.swarmfeedEnabled && a.swarmfeedApiKey)
    agentApiKey = feedAgent?.swarmfeedApiKey ?? undefined
    // No registered agent — return empty feed instead of triggering a 401
    if (!agentApiKey) {
      return NextResponse.json({ posts: [], nextCursor: undefined })
    }
  }

  try {
    const result = await getFeed(type, { channelId, cursor, limit }, agentApiKey)
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch feed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
