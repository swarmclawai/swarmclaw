import { hmrSingleton } from '@/lib/shared-utils'
import type {
  CreatePostInput,
  FeedType,
  SwarmFeedChannel,
  SwarmFeedFeedResponse,
  SwarmFeedFollowState,
  SwarmFeedNotificationsResponse,
  SwarmFeedPost,
  SwarmFeedProfile,
  SwarmFeedReactionType,
  SwarmFeedSearchResponse,
  SwarmFeedSearchType,
  SwarmFeedSuggestedResponse,
} from '@/types/swarmfeed'

interface SwarmFeedConfig {
  apiUrl: string
}

const config = hmrSingleton<SwarmFeedConfig>('swarmfeed_config', () => ({
  apiUrl: process.env.SWARMFEED_API_URL || 'https://swarmfeed-api.onrender.com',
}))

async function sfFetch<T>(path: string, agentApiKey?: string, init?: RequestInit): Promise<T> {
  const url = `${config.apiUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(agentApiKey ? { Authorization: `Bearer ${agentApiKey}` } : {}),
  }
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    throw new Error(`SwarmFeed API error ${res.status}: ${text}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const FEED_TYPE_URL: Record<FeedType, string> = {
  for_you: 'for-you',
  following: 'following',
  channel: 'channel',
  trending: 'trending',
}

export async function getFeed(
  type: FeedType,
  params?: { channelId?: string; cursor?: string; limit?: number },
  agentApiKey?: string,
): Promise<SwarmFeedFeedResponse> {
  const urlSegment = FEED_TYPE_URL[type] ?? type

  if (type === 'channel' && params?.channelId) {
    const searchParams = new URLSearchParams()
    if (params.cursor) searchParams.set('cursor', params.cursor)
    if (params.limit) searchParams.set('limit', String(params.limit))
    const qs = searchParams.toString()
    return sfFetch(`/api/v1/feed/channel/${params.channelId}${qs ? `?${qs}` : ''}`, agentApiKey)
  }

  const searchParams = new URLSearchParams()
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  const qs = searchParams.toString()
  return sfFetch(`/api/v1/feed/${urlSegment}${qs ? `?${qs}` : ''}`, agentApiKey)
}

export async function createPost(agentApiKey: string, input: CreatePostInput): Promise<SwarmFeedPost> {
  return sfFetch('/api/v1/posts', agentApiKey, {
    method: 'POST',
    body: JSON.stringify({
      content: input.content,
      channelId: input.channelId,
      parentId: input.parentId,
      quotedPostId: input.quotedPostId,
    }),
  })
}

export async function getPost(postId: string): Promise<SwarmFeedPost> {
  return sfFetch(`/api/v1/posts/${postId}`)
}

export async function getPostReplies(
  postId: string,
  params?: { cursor?: string; limit?: number },
): Promise<SwarmFeedFeedResponse> {
  const searchParams = new URLSearchParams()
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  const qs = searchParams.toString()
  return sfFetch(`/api/v1/posts/${postId}/replies${qs ? `?${qs}` : ''}`)
}

async function addReaction(agentApiKey: string, postId: string, reactionType: SwarmFeedReactionType): Promise<void> {
  await sfFetch(`/api/v1/posts/${postId}/like`, agentApiKey, {
    method: 'POST',
    body: JSON.stringify({ reactionType }),
  })
}

async function removeReaction(agentApiKey: string, postId: string, reactionType: SwarmFeedReactionType): Promise<void> {
  await sfFetch(`/api/v1/posts/${postId}/like?reactionType=${encodeURIComponent(reactionType)}`, agentApiKey, {
    method: 'DELETE',
  })
}

export async function likePost(agentApiKey: string, postId: string): Promise<void> {
  await addReaction(agentApiKey, postId, 'like')
}

export async function unlikePost(agentApiKey: string, postId: string): Promise<void> {
  await removeReaction(agentApiKey, postId, 'like')
}

export async function repostPost(agentApiKey: string, postId: string): Promise<void> {
  await addReaction(agentApiKey, postId, 'repost')
}

export async function unrepostPost(agentApiKey: string, postId: string): Promise<void> {
  await removeReaction(agentApiKey, postId, 'repost')
}

export async function bookmarkPost(agentApiKey: string, postId: string): Promise<void> {
  await addReaction(agentApiKey, postId, 'bookmark')
}

export async function unbookmarkPost(agentApiKey: string, postId: string): Promise<void> {
  await removeReaction(agentApiKey, postId, 'bookmark')
}

export async function getChannels(): Promise<SwarmFeedChannel[]> {
  const result = await sfFetch<{ channels: SwarmFeedChannel[] }>('/api/v1/channels')
  return result.channels
}

export async function getProfile(agentId: string): Promise<SwarmFeedProfile> {
  return sfFetch(`/api/v1/agents/${agentId}/profile`)
}

export async function getProfilePosts(
  agentId: string,
  params?: { cursor?: string; limit?: number; filter?: 'posts' | 'replies' },
): Promise<SwarmFeedFeedResponse> {
  const searchParams = new URLSearchParams()
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.filter) searchParams.set('filter', params.filter)
  const qs = searchParams.toString()
  return sfFetch(`/api/v1/agents/${agentId}/posts${qs ? `?${qs}` : ''}`)
}

export async function getBookmarks(
  agentApiKey: string,
  params?: { cursor?: string; limit?: number },
): Promise<SwarmFeedFeedResponse> {
  const searchParams = new URLSearchParams()
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  const qs = searchParams.toString()
  return sfFetch(`/api/v1/bookmarks${qs ? `?${qs}` : ''}`, agentApiKey)
}

export async function getNotifications(
  agentApiKey: string,
  params?: { cursor?: string; limit?: number },
): Promise<SwarmFeedNotificationsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  const qs = searchParams.toString()
  return sfFetch(`/api/v1/notifications${qs ? `?${qs}` : ''}`, agentApiKey)
}

export async function getSuggestedFollows(agentApiKey?: string, limit?: number): Promise<SwarmFeedSuggestedResponse> {
  const searchParams = new URLSearchParams()
  if (limit) searchParams.set('limit', String(limit))
  const qs = searchParams.toString()
  return sfFetch(`/api/v1/agents/suggested${qs ? `?${qs}` : ''}`, agentApiKey)
}

export async function followAgent(agentApiKey: string, targetAgentId: string): Promise<void> {
  await sfFetch(`/api/v1/agents/${targetAgentId}/follow`, agentApiKey, { method: 'POST' })
}

export async function unfollowAgent(agentApiKey: string, targetAgentId: string): Promise<void> {
  await sfFetch(`/api/v1/agents/${targetAgentId}/follow`, agentApiKey, { method: 'DELETE' })
}

export async function getFollowState(agentId: string, targetAgentId: string): Promise<SwarmFeedFollowState> {
  return sfFetch(`/api/v1/agents/${agentId}/is-following?targetId=${encodeURIComponent(targetAgentId)}`)
}

export async function searchSwarmFeed(params: {
  query: string
  type?: SwarmFeedSearchType
  limit?: number
  offset?: number
}): Promise<SwarmFeedSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.query)
  if (params.type) searchParams.set('type', params.type)
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.offset) searchParams.set('offset', String(params.offset))
  return sfFetch(`/api/v1/search?${searchParams.toString()}`)
}

interface RegisterResult {
  agentId: string
  apiKey: string
  challenge: string
  challengeExpiresAt: string
}

export async function registerAgent(agent: {
  name: string
  description?: string
  framework?: string
  model?: string
  avatar?: string
  bio?: string
}): Promise<{ agentId: string; apiKey: string }> {
  const naclModule = await import('tweetnacl')
  const nacl = naclModule.default ?? naclModule
  const keypair = nacl.sign.keyPair()
  const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex')

  const reg = await sfFetch<RegisterResult>('/api/v1/register', undefined, {
    method: 'POST',
    body: JSON.stringify({
      publicKey: publicKeyHex,
      name: agent.name,
      description: agent.description,
      framework: agent.framework,
      modelName: agent.model,
      avatarUrl: agent.avatar,
      bio: agent.bio,
    }),
  })

  const messageBytes = new TextEncoder().encode(reg.challenge)
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey)
  const signatureHex = Buffer.from(signature).toString('hex')

  await sfFetch('/api/v1/register/verify', undefined, {
    method: 'POST',
    body: JSON.stringify({
      publicKey: publicKeyHex,
      challenge: reg.challenge,
      signature: signatureHex,
    }),
  })

  return { agentId: reg.agentId, apiKey: reg.apiKey }
}
