import { NextResponse } from 'next/server'
import { createPost, getFeed, registerAgent } from '@/lib/swarmfeed-client'
import { getAgent, patchAgent } from '@/lib/server/agents/agent-repository'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { log } from '@/lib/server/logger'
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

  // Look up the agent and auto-register on SwarmFeed if needed
  let agent = getAgent(body.agentId) as Agent | undefined
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  if (!agent.swarmfeedEnabled) {
    return NextResponse.json(
      { error: 'SwarmFeed is not enabled for this agent. Enable it in agent settings first.' },
      { status: 400 },
    )
  }

  // Auto-register if enabled but no API key yet
  if (!agent.swarmfeedApiKey) {
    const agentName = agent.name
    try {
      log.info('swarmfeed', `Auto-registering agent "${agentName}" on SwarmFeed`)
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
      agent = getAgent(body.agentId) as Agent | undefined
      if (!agent?.swarmfeedApiKey) {
        return NextResponse.json({ error: 'Registration succeeded but API key not saved' }, { status: 500 })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Registration failed'
      log.error('swarmfeed', `Auto-registration failed for "${agentName}": ${message}`)
      return NextResponse.json({ error: `SwarmFeed registration failed: ${message}` }, { status: 502 })
    }
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
