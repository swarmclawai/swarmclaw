import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'


const REGISTRY_URL = 'https://swarmclaw.ai/registry/plugins.json'
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

let cache: { data: any; fetchedAt: number } | null = null

export async function GET(_req: Request) {
  const now = Date.now()

  if (cache && now - cache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cache.data)
  }

  try {
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' })
    if (!res.ok) {
      throw new Error(`Registry returned ${res.status}`)
    }
    const data = await res.json()
    cache = { data, fetchedAt: now }
    return NextResponse.json(data)
  } catch (err: any) {
    // Return stale cache if available
    if (cache) {
      return NextResponse.json(cache.data)
    }
    return NextResponse.json(
      { error: 'Failed to fetch plugin registry', message: err.message },
      { status: 502 },
    )
  }
}
