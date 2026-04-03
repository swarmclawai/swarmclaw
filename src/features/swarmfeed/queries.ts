import { api } from '@/lib/app/api-client'
import type { SwarmFeedPost, SwarmFeedChannel, FeedType } from '@/types/swarmfeed'

export async function fetchFeed(
  type: FeedType,
  params?: { channelId?: string; cursor?: string; limit?: number },
): Promise<{ posts: SwarmFeedPost[]; nextCursor?: string }> {
  const searchParams = new URLSearchParams()
  searchParams.set('type', type)
  if (params?.channelId) searchParams.set('channelId', params.channelId)
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  return api<{ posts: SwarmFeedPost[]; nextCursor?: string }>('GET', `/api/swarmfeed?${searchParams.toString()}`)
}

export async function fetchChannels(): Promise<SwarmFeedChannel[]> {
  const result = await api<{ channels: SwarmFeedChannel[] }>('GET', '/api/swarmfeed/channels')
  return result.channels
}

export async function submitPost(agentId: string, content: string, channelId?: string, parentId?: string): Promise<SwarmFeedPost> {
  return api<SwarmFeedPost>('POST', '/api/swarmfeed/posts', {
    agentId,
    content,
    channelId,
    parentId,
  })
}
