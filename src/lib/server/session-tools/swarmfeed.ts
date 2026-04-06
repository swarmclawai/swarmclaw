import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { ensureSwarmFeedAgent } from '@/lib/server/agents/agent-swarm-registration'
import {
  bookmarkPost,
  createPost,
  followAgent,
  getChannels,
  getFeed,
  getNotifications,
  getPost,
  getPostReplies,
  getProfile,
  getSuggestedFollows,
  likePost,
  repostPost,
  searchSwarmFeed,
  unbookmarkPost,
  unfollowAgent,
  unlikePost,
  unrepostPost,
} from '@/lib/swarmfeed-client'
import { canAutoPostToSwarmFeed, markSwarmFeedAutoPost } from '@/lib/server/swarmfeed-runtime'
import { log } from '@/lib/server/logger'
import type { ToolBuildContext } from './context'
import type { Agent } from '@/types'

const TAG = 'swarmfeed-tool'

const SWARMFEED_SCHEMA = z.object({
  action: z.enum([
    'post',
    'reply',
    'quote_repost',
    'like',
    'unlike',
    'repost',
    'unrepost',
    'bookmark',
    'unbookmark',
    'follow',
    'unfollow',
    'browse_feed',
    'search',
    'get_channels',
    'get_post_thread',
    'get_notifications',
    'get_profile',
    'get_suggested_follows',
  ]).describe('The SwarmFeed action to perform'),
  content: z.string().optional().describe('Post or reply content'),
  postId: z.string().optional().describe('Post ID for thread/reaction/reply actions'),
  channelId: z.string().optional().describe('Channel ID for posting or browsing a channel feed'),
  feedType: z.enum(['for_you', 'following', 'trending', 'channel']).optional().describe('Feed type for browse_feed'),
  limit: z.number().optional().describe('Number of items to fetch'),
  targetAgentId: z.string().optional().describe('Remote SwarmFeed agent ID for follow/unfollow/get_profile'),
  query: z.string().optional().describe('Search query for search action'),
  searchType: z.enum(['posts', 'agents', 'channels', 'hashtags']).optional().describe('Filter for search action'),
})

type SwarmFeedInput = z.infer<typeof SWARMFEED_SCHEMA>

function isAutonomousSocialPostSession(bctx: ToolBuildContext): boolean {
  const session = bctx.resolveCurrentSession()
  return Boolean(session?.heartbeatEnabled)
}

async function getScopedAgent(agentId: string): Promise<Agent> {
  return ensureSwarmFeedAgent(agentId)
}

function summarizePosts(posts: Array<{
  id: string
  agent?: { name?: string | null }
  agentId: string
  content: string
  likeCount: number
  replyCount: number
  repostCount: number
  createdAt: string
}>): Array<Record<string, unknown>> {
  return posts.map((post) => ({
    id: post.id,
    agentId: post.agentId,
    agentName: post.agent?.name || null,
    content: post.content.slice(0, 500),
    likes: post.likeCount,
    replies: post.replyCount,
    reposts: post.repostCount,
    createdAt: post.createdAt,
  }))
}

async function executeSwarmFeed(input: SwarmFeedInput, bctx: ToolBuildContext): Promise<string> {
  const agentId = bctx.ctx?.agentId
  if (!agentId) return JSON.stringify({ error: 'No agent context' })

  const storedAgent = getAgent(agentId) as Agent | undefined
  if (!storedAgent) return JSON.stringify({ error: 'Agent not found' })
  if (!storedAgent.swarmfeedEnabled) return JSON.stringify({ error: 'SwarmFeed is not enabled for this agent' })

  const autoPostPolicy = canAutoPostToSwarmFeed(storedAgent)
  const autonomousSession = isAutonomousSocialPostSession(bctx)

  try {
    switch (input.action) {
      case 'post': {
        if (!input.content?.trim()) return JSON.stringify({ error: 'content is required for post action' })
        if (autonomousSession && !autoPostPolicy.allowed) return JSON.stringify({ error: autoPostPolicy.reason })
        const agent = await getScopedAgent(agentId)
        const post = await createPost(agent.swarmfeedApiKey!, {
          content: input.content.trim(),
          channelId: input.channelId,
        })
        if (autonomousSession) markSwarmFeedAutoPost(agentId)
        return JSON.stringify({ success: true, post: { id: post.id, content: post.content, createdAt: post.createdAt } })
      }

      case 'reply': {
        if (!input.content?.trim()) return JSON.stringify({ error: 'content is required for reply action' })
        if (!input.postId) return JSON.stringify({ error: 'postId is required for reply action' })
        if (autonomousSession && !autoPostPolicy.allowed) return JSON.stringify({ error: autoPostPolicy.reason })
        const agent = await getScopedAgent(agentId)
        const reply = await createPost(agent.swarmfeedApiKey!, {
          content: input.content.trim(),
          parentId: input.postId,
          channelId: input.channelId,
        })
        if (autonomousSession) markSwarmFeedAutoPost(agentId)
        return JSON.stringify({
          success: true,
          post: { id: reply.id, content: reply.content, parentId: input.postId, createdAt: reply.createdAt },
        })
      }

      case 'quote_repost': {
        if (!input.content?.trim()) return JSON.stringify({ error: 'content is required for quote_repost action' })
        if (!input.postId) return JSON.stringify({ error: 'postId is required for quote_repost action' })
        if (autonomousSession && !autoPostPolicy.allowed) return JSON.stringify({ error: autoPostPolicy.reason })
        const agent = await getScopedAgent(agentId)
        const post = await createPost(agent.swarmfeedApiKey!, {
          content: input.content.trim(),
          channelId: input.channelId,
          quotedPostId: input.postId,
        })
        if (autonomousSession) markSwarmFeedAutoPost(agentId)
        return JSON.stringify({ success: true, post: { id: post.id, content: post.content, quotedPostId: input.postId, createdAt: post.createdAt } })
      }

      case 'like': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for like action' })
        const agent = await getScopedAgent(agentId)
        await likePost(agent.swarmfeedApiKey!, input.postId)
        return JSON.stringify({ success: true, action: 'liked', postId: input.postId })
      }

      case 'unlike': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for unlike action' })
        const agent = await getScopedAgent(agentId)
        await unlikePost(agent.swarmfeedApiKey!, input.postId)
        return JSON.stringify({ success: true, action: 'unliked', postId: input.postId })
      }

      case 'repost': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for repost action' })
        const agent = await getScopedAgent(agentId)
        await repostPost(agent.swarmfeedApiKey!, input.postId)
        return JSON.stringify({ success: true, action: 'reposted', postId: input.postId })
      }

      case 'unrepost': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for unrepost action' })
        const agent = await getScopedAgent(agentId)
        await unrepostPost(agent.swarmfeedApiKey!, input.postId)
        return JSON.stringify({ success: true, action: 'unreposted', postId: input.postId })
      }

      case 'bookmark': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for bookmark action' })
        const agent = await getScopedAgent(agentId)
        await bookmarkPost(agent.swarmfeedApiKey!, input.postId)
        return JSON.stringify({ success: true, action: 'bookmarked', postId: input.postId })
      }

      case 'unbookmark': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for unbookmark action' })
        const agent = await getScopedAgent(agentId)
        await unbookmarkPost(agent.swarmfeedApiKey!, input.postId)
        return JSON.stringify({ success: true, action: 'unbookmarked', postId: input.postId })
      }

      case 'follow': {
        if (!input.targetAgentId) return JSON.stringify({ error: 'targetAgentId is required for follow action' })
        const agent = await getScopedAgent(agentId)
        await followAgent(agent.swarmfeedApiKey!, input.targetAgentId)
        return JSON.stringify({ success: true, action: 'followed', targetAgentId: input.targetAgentId })
      }

      case 'unfollow': {
        if (!input.targetAgentId) return JSON.stringify({ error: 'targetAgentId is required for unfollow action' })
        const agent = await getScopedAgent(agentId)
        await unfollowAgent(agent.swarmfeedApiKey!, input.targetAgentId)
        return JSON.stringify({ success: true, action: 'unfollowed', targetAgentId: input.targetAgentId })
      }

      case 'browse_feed': {
        const feedType = input.feedType || 'for_you'
        const limit = input.limit || 10
        const agent = feedType === 'following' || autonomousSession ? await getScopedAgent(agentId) : storedAgent
        const result = await getFeed(feedType, { channelId: input.channelId, limit }, agent.swarmfeedApiKey || undefined)
        return JSON.stringify({ posts: summarizePosts(result.posts), nextCursor: result.nextCursor })
      }

      case 'search': {
        if (!input.query?.trim()) return JSON.stringify({ error: 'query is required for search action' })
        const result = await searchSwarmFeed({
          query: input.query.trim(),
          type: input.searchType,
          limit: input.limit || 10,
        })
        return JSON.stringify({
          total: result.total,
          posts: summarizePosts(result.posts || []),
          agents: (result.agents || []).map((agent) => ({
            id: agent.id,
            name: agent.name,
            framework: agent.framework || null,
            followerCount: agent.followerCount,
            bio: agent.bio || null,
          })),
          channels: (result.channels || []).map((channel) => ({
            id: channel.id,
            handle: channel.handle,
            displayName: channel.displayName,
            memberCount: channel.memberCount,
          })),
          hashtags: result.hashtags || [],
        })
      }

      case 'get_channels': {
        const channels = await getChannels()
        return JSON.stringify({
          channels: channels.map((channel) => ({
            id: channel.id,
            name: channel.displayName,
            handle: channel.handle,
            description: channel.description || null,
            memberCount: channel.memberCount,
          })),
        })
      }

      case 'get_post_thread': {
        if (!input.postId) return JSON.stringify({ error: 'postId is required for get_post_thread action' })
        const [post, replies] = await Promise.all([
          getPost(input.postId),
          getPostReplies(input.postId, { limit: input.limit || 20 }),
        ])
        return JSON.stringify({
          post,
          replies: summarizePosts(replies.posts),
          nextCursor: replies.nextCursor,
        })
      }

      case 'get_notifications': {
        const agent = await getScopedAgent(agentId)
        const result = await getNotifications(agent.swarmfeedApiKey!, { limit: input.limit || 20 })
        return JSON.stringify(result)
      }

      case 'get_profile': {
        if (!input.targetAgentId) return JSON.stringify({ error: 'targetAgentId is required for get_profile action' })
        return JSON.stringify(await getProfile(input.targetAgentId))
      }

      case 'get_suggested_follows': {
        const agent = await getScopedAgent(agentId)
        return JSON.stringify(await getSuggestedFollows(agent.swarmfeedApiKey!, input.limit || 5))
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${input.action}` })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    log.error(TAG, `Action "${input.action}" failed for agent "${storedAgent.name}": ${message}`)
    return JSON.stringify({ error: message })
  }
}

export function buildSwarmFeedTools(bctx: ToolBuildContext): StructuredToolInterface[] {
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
          'Actions include posting, replying, quote reposting, liking, bookmarking, following, searching, browsing feeds, reading threads, checking notifications, and viewing profiles.',
        schema: SWARMFEED_SCHEMA,
      },
    ),
  ]
}
