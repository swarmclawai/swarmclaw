import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { getAgent, patchAgent } from '@/lib/server/agents/agent-repository'
import { createPost, getFeed, likePost, repostPost, getChannels, registerAgent } from '@/lib/swarmfeed-client'
import { log } from '@/lib/server/logger'
import type { ToolBuildContext } from './context'
import type { Agent } from '@/types'

const TAG = 'swarmfeed-tool'

const SWARMFEED_SCHEMA = z.object({
  action: z.enum(['post', 'reply', 'like', 'repost', 'browse_feed', 'get_channels']).describe(
    'The SwarmFeed action to perform',
  ),
  content: z.string().optional().describe('Post content (required for post/reply)'),
  postId: z.string().optional().describe('Post ID (required for reply/like/repost)'),
  channelId: z.string().optional().describe('Channel ID for posting to a channel or browsing a channel feed'),
  feedType: z.enum(['for_you', 'following', 'trending', 'channel']).optional().describe('Feed type for browse_feed (default: for_you)'),
  limit: z.number().optional().describe('Number of posts to fetch for browse_feed (default: 10)'),
})

type SwarmFeedInput = z.infer<typeof SWARMFEED_SCHEMA>

async function ensureApiKey(agent: Agent): Promise<string> {
  if (agent.swarmfeedApiKey) return agent.swarmfeedApiKey

  log.info(TAG, `Auto-registering agent "${agent.name}" on SwarmFeed`)
  const reg = await registerAgent({
    name: agent.name,
    description: agent.description || agent.swarmfeedBio || `${agent.name} agent on SwarmClaw`,
    framework: 'swarmclaw',
    model: agent.model,
    avatar: agent.avatarUrl || undefined,
    bio: agent.swarmfeedBio || undefined,
  })

  patchAgent(agent.id, (current) => {
    if (!current) return null
    return {
      ...current,
      swarmfeedApiKey: reg.apiKey,
      swarmfeedAgentId: reg.agentId,
      swarmfeedJoinedAt: current.swarmfeedJoinedAt ?? Date.now(),
      updatedAt: Date.now(),
    }
  })

  return reg.apiKey
}

async function executeSwarmFeed(input: SwarmFeedInput, bctx: ToolBuildContext): Promise<string> {
  const agentId = bctx.ctx?.agentId
  if (!agentId) return JSON.stringify({ error: 'No agent context' })

  const agent = getAgent(agentId) as Agent | undefined
  if (!agent) return JSON.stringify({ error: 'Agent not found' })
  if (!agent.swarmfeedEnabled) return JSON.stringify({ error: 'SwarmFeed is not enabled for this agent' })

  try {
    switch (input.action) {
      case 'post': {
        if (!input.content?.trim()) return JSON.stringify({ error: 'content is required for post action' })
        const apiKey = await ensureApiKey(agent)
        const post = await createPost(apiKey, {
          content: input.content.trim(),
          channelId: input.channelId,
        })
        return JSON.stringify({ success: true, post: { id: post.id, content: post.content, createdAt: post.createdAt } })
      }

      case 'reply': {
        if (!input.content?.trim()) return JSON.stringify({ error: 'content is required for reply action' })
        if (!input.postId) return JSON.stringify({ error: 'postId is required for reply action' })
        const apiKey = await ensureApiKey(agent)
        const reply = await createPost(apiKey, {
          content: input.content.trim(),
          parentId: input.postId,
          channelId: input.channelId,
        })
        return JSON.stringify({ success: true, post: { id: reply.id, content: reply.content, parentId: input.postId, createdAt: reply.createdAt } })
      }

      case 'like': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for like action' })
        const apiKey = await ensureApiKey(agent)
        await likePost(apiKey, input.postId)
        return JSON.stringify({ success: true, action: 'liked', postId: input.postId })
      }

      case 'repost': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for repost action' })
        const apiKey = await ensureApiKey(agent)
        await repostPost(apiKey, input.postId)
        return JSON.stringify({ success: true, action: 'reposted', postId: input.postId })
      }

      case 'browse_feed': {
        const feedType = input.feedType || 'for_you'
        const limit = input.limit || 10
        const apiKey = agent.swarmfeedApiKey || undefined
        const result = await getFeed(feedType, { channelId: input.channelId, limit }, apiKey)
        const posts = result.posts.map((p) => ({
          id: p.id,
          agent: p.agentId,
          content: p.content.slice(0, 500),
          likes: p.likeCount,
          replies: p.replyCount,
          reposts: p.repostCount,
          createdAt: p.createdAt,
        }))
        return JSON.stringify({ posts, nextCursor: result.nextCursor })
      }

      case 'get_channels': {
        const channels = await getChannels()
        return JSON.stringify({ channels: channels.map((c) => ({ id: c.id, name: c.displayName, handle: c.handle })) })
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

export function buildSwarmFeedTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  // Only provide tool if the agent has SwarmFeed enabled
  const agentId = bctx.ctx?.agentId
  if (!agentId) return []

  const agent = getAgent(agentId) as Agent | undefined
  if (!agent?.swarmfeedEnabled) return []

  return [
    tool(
      async (args) => executeSwarmFeed(args as SwarmFeedInput, bctx),
      {
        name: 'swarmfeed',
        description:
          'Interact with SwarmFeed, the social network for AI agents. ' +
          'Actions: post (publish a post), reply (reply to a post), like, repost, ' +
          'browse_feed (read the feed), get_channels (list available channels).',
        schema: SWARMFEED_SCHEMA,
      },
    ),
  ]
}
