import { NextResponse } from 'next/server'
import {
  bookmarkPost,
  createPost,
  followAgent,
  likePost,
  repostPost,
  unbookmarkPost,
  unfollowAgent,
  unlikePost,
  unrepostPost,
} from '@/lib/swarmfeed-client'
import { ensureSwarmFeedAgent } from '@/lib/server/agents/agent-swarm-registration'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export const dynamic = 'force-dynamic'

type SwarmFeedAction =
  | 'like'
  | 'unlike'
  | 'repost'
  | 'unrepost'
  | 'bookmark'
  | 'unbookmark'
  | 'follow'
  | 'unfollow'
  | 'quote_repost'

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<{
    action?: SwarmFeedAction
    agentId?: string
    postId?: string
    targetAgentId?: string
    content?: string
    channelId?: string
  }>(req)
  if (error) return error

  const action = body?.action
  const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 })
  if (!agentId) return NextResponse.json({ error: 'agentId is required' }, { status: 400 })

  try {
    const agent = await ensureSwarmFeedAgent(agentId)

    switch (action) {
      case 'like':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        await likePost(agent.swarmfeedApiKey!, body.postId)
        return NextResponse.json({ ok: true, action, postId: body.postId })
      case 'unlike':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        await unlikePost(agent.swarmfeedApiKey!, body.postId)
        return NextResponse.json({ ok: true, action, postId: body.postId })
      case 'repost':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        await repostPost(agent.swarmfeedApiKey!, body.postId)
        return NextResponse.json({ ok: true, action, postId: body.postId })
      case 'unrepost':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        await unrepostPost(agent.swarmfeedApiKey!, body.postId)
        return NextResponse.json({ ok: true, action, postId: body.postId })
      case 'bookmark':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        await bookmarkPost(agent.swarmfeedApiKey!, body.postId)
        return NextResponse.json({ ok: true, action, postId: body.postId })
      case 'unbookmark':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        await unbookmarkPost(agent.swarmfeedApiKey!, body.postId)
        return NextResponse.json({ ok: true, action, postId: body.postId })
      case 'follow':
        if (!body.targetAgentId) return NextResponse.json({ error: 'targetAgentId is required' }, { status: 400 })
        await followAgent(agent.swarmfeedApiKey!, body.targetAgentId)
        return NextResponse.json({ ok: true, action, targetAgentId: body.targetAgentId })
      case 'unfollow':
        if (!body.targetAgentId) return NextResponse.json({ error: 'targetAgentId is required' }, { status: 400 })
        await unfollowAgent(agent.swarmfeedApiKey!, body.targetAgentId)
        return NextResponse.json({ ok: true, action, targetAgentId: body.targetAgentId })
      case 'quote_repost':
        if (!body.postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })
        if (!body.content?.trim()) return NextResponse.json({ error: 'content is required' }, { status: 400 })
        return NextResponse.json(await createPost(agent.swarmfeedApiKey!, {
          content: body.content.trim(),
          channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
          quotedPostId: body.postId,
        }))
      default:
        return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'SwarmFeed action failed'
    const status = message === 'Agent not found'
      ? 404
      : message.includes('not enabled')
        ? 400
        : 502
    return NextResponse.json({ error: message }, { status })
  }
}
