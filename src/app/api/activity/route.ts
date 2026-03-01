import { NextResponse } from 'next/server'
import { loadActivity } from '@/lib/server/storage'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const entityType = searchParams.get('entityType')
  const entityId = searchParams.get('entityId')
  const action = searchParams.get('action')
  const since = searchParams.get('since')
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 50))

  const all = loadActivity()
  let entries = Object.values(all) as Array<Record<string, unknown>>

  if (entityType) entries = entries.filter((e) => e.entityType === entityType)
  if (entityId) entries = entries.filter((e) => e.entityId === entityId)
  if (action) entries = entries.filter((e) => e.action === action)
  if (since) {
    const sinceMs = Number(since)
    if (Number.isFinite(sinceMs)) {
      entries = entries.filter((e) => typeof e.timestamp === 'number' && e.timestamp >= sinceMs)
    }
  }

  entries.sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
  entries = entries.slice(0, limit)

  return NextResponse.json(entries)
}
