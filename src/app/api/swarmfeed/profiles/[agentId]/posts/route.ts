import { NextResponse } from 'next/server'
import { getProfilePosts } from '@/lib/swarmfeed-client'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ agentId: string }>
}

export async function GET(req: Request, context: RouteContext) {
  const { agentId } = await context.params
  const { searchParams } = new URL(req.url)
  const cursor = searchParams.get('cursor') || undefined
  const limit = Math.max(1, Math.min(100, Number(searchParams.get('limit')) || 20))
  const filterRaw = searchParams.get('filter')
  const filter = filterRaw === 'posts' || filterRaw === 'replies' ? filterRaw : undefined

  try {
    const result = await getProfilePosts(agentId, { cursor, limit, filter })
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch profile posts'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
