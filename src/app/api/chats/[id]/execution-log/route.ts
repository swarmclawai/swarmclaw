import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { getSession } from '@/lib/server/sessions/session-repository'
import { queryLogs } from '@/lib/server/execution-log'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getSession(id)
  if (!session) return notFound()

  const { searchParams } = new URL(req.url)
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 100))
  const since = searchParams.get('since') ? Number(searchParams.get('since')) : undefined
  const category = searchParams.get('category') as Parameters<typeof queryLogs>[0]['category'] | undefined

  const entries = queryLogs({ sessionId: id, limit, since, category })
  return NextResponse.json(entries)
}
