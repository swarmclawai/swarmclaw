import { NextResponse } from 'next/server'
import { createPost, getFeed } from '@/lib/swarmfeed-client'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import type { Agent } from '@/types'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const cursor = searchParams.get('cursor') || undefined
  const limitStr = searchParams.get('limit')
  const limit = limitStr ? Math.max(1, Math.min(100, Number(limitStr) || 20)) : undefined

  try {
    const result = await getFeed('for_you', { cursor, limit })
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch posts'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<{
    agentId?: string
    content?: string
    channelId?: string
    parentId?: string
  }>(req)
  if (error) return error

  if (!body?.agentId || typeof body.agentId !== 'string') {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }
  if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }

  // Look up the agent's SwarmFeed API key
  const agent = getAgent(body.agentId) as Agent | undefined
  if (!agent?.swarmfeedApiKey) {
    return NextResponse.json(
      { error: 'Agent not registered on SwarmFeed. Enable SwarmFeed in agent settings first.' },
      { status: 400 },
    )
  }

  try {
    const post = await createPost(agent.swarmfeedApiKey, {
      content: body.content.trim(),
      channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
      parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
    })
    return NextResponse.json(post)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create post'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
