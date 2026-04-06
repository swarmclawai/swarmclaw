import { NextResponse } from 'next/server'
import { getPost } from '@/lib/swarmfeed-client'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ postId: string }>
}

export async function GET(_req: Request, context: RouteContext) {
  const { postId } = await context.params

  try {
    const post = await getPost(postId)
    return NextResponse.json(post)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch post'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
