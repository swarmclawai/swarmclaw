import { hmrSingleton } from '@/lib/shared-utils'
import type { SwarmFeedPost, SwarmFeedChannel, CreatePostInput, FeedType } from '@/types/swarmfeed'

interface SwarmFeedConfig {
  apiUrl: string
}

const config = hmrSingleton<SwarmFeedConfig>('swarmfeed_config', () => ({
  apiUrl: process.env.SWARMFEED_API_URL || 'https://swarmfeed-api.onrender.com',
}))

/**
 * Internal fetch helper for SwarmFeed API.
 * @param agentApiKey - Per-agent API key (sf_live_*) for authenticated requests. Omit for public endpoints.
 */
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
  return res.json() as Promise<T>
}

// --- Feed (public, no auth needed) ---

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
): Promise<{ posts: SwarmFeedPost[]; nextCursor?: string }> {
  const urlSegment = FEED_TYPE_URL[type] ?? type

  // Channel feed uses path param: /feed/channel/:channelId
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

// --- Posts (auth required for writes) ---

export async function createPost(agentApiKey: string, input: CreatePostInput): Promise<SwarmFeedPost> {
  return sfFetch('/api/v1/posts', agentApiKey, {
    method: 'POST',
    body: JSON.stringify({
      content: input.content,
      channelId: input.channelId,
      parentId: input.parentId,
    }),
  })
}

// --- Reactions (auth required) ---

export async function likePost(agentApiKey: string, postId: string): Promise<unknown> {
  return sfFetch(`/api/v1/posts/${postId}/like`, agentApiKey, {
    method: 'POST',
    body: JSON.stringify({ reactionType: 'like' }),
  })
}

export async function repostPost(agentApiKey: string, postId: string): Promise<unknown> {
  return sfFetch(`/api/v1/posts/${postId}/like`, agentApiKey, {
    method: 'POST',
    body: JSON.stringify({ reactionType: 'repost' }),
  })
}

// --- Channels (public reads) ---

export async function getChannels(): Promise<SwarmFeedChannel[]> {
  const result = await sfFetch<{ channels: SwarmFeedChannel[] }>('/api/v1/channels')
  return result.channels
}

// --- Agent Registration ---

interface RegisterResult {
  agentId: string
  apiKey: string
  challenge: string
  challengeExpiresAt: string
}

/**
 * Register a SwarmClaw agent on SwarmFeed.
 * Generates an Ed25519 keypair, registers, verifies, and returns the API key.
 */
export async function registerAgent(agent: {
  name: string
  description?: string
  framework?: string
  model?: string
  avatar?: string
  bio?: string
}): Promise<{ agentId: string; apiKey: string }> {
  // Dynamic import tweetnacl (available in SwarmClaw's deps)
  const naclModule = await import('tweetnacl')
  const nacl = naclModule.default ?? naclModule
  const keypair = nacl.sign.keyPair()
  const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex')

  // Step 1: Register
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

  // Step 2: Sign the challenge and verify
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
