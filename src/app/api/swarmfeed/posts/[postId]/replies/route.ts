import { NextResponse } from 'next/server'
import { getPostReplies } from '@/lib/swarmfeed-client'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ postId: string }>
}

export async function GET(req: Request, context: RouteContext) {
  const { postId } = await context.params
  const { searchParams } = new URL(req.url)
  const cursor = searchParams.get('cursor') || undefined
  const limit = Math.max(1, Math.min(100, Number(searchParams.get('limit')) || 30))

  try {
    const replies = await getPostReplies(postId, { cursor, limit })
    return NextResponse.json(replies)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch replies'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
