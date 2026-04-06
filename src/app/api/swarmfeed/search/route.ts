import { NextResponse } from 'next/server'
import { searchSwarmFeed } from '@/lib/swarmfeed-client'
import type { SwarmFeedSearchType } from '@/types/swarmfeed'

export const dynamic = 'force-dynamic'

const VALID_SEARCH_TYPES = new Set<SwarmFeedSearchType>(['posts', 'agents', 'channels', 'hashtags'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const query = (searchParams.get('q') || '').trim()
  const typeRaw = searchParams.get('type') || undefined
  const type = typeRaw && VALID_SEARCH_TYPES.has(typeRaw as SwarmFeedSearchType)
    ? typeRaw as SwarmFeedSearchType
    : undefined
  const limit = Math.max(1, Math.min(50, Number(searchParams.get('limit')) || 12))
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)

  if (!query) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 })
  }

  try {
    const results = await searchSwarmFeed({ query, type, limit, offset })
    return NextResponse.json(results)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to search SwarmFeed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
