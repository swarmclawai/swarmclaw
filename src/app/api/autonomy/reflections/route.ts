import { NextResponse } from 'next/server'

import { listRunReflections } from '@/lib/server/autonomy/supervisor-reflection'

export const dynamic = 'force-dynamic'

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId') || undefined
  const taskId = url.searchParams.get('taskId') || undefined
  const limit = parseLimit(url.searchParams.get('limit'))
  return NextResponse.json(listRunReflections({ sessionId, taskId, limit }))
}
