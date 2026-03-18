import { NextResponse } from 'next/server'
import { perf } from '@/lib/server/runtime/perf'
import {
  createChatSession,
  deleteChats,
  listChatsForApi,
} from '@/lib/server/chats/chat-session-service'
export const dynamic = 'force-dynamic'

async function ensureDaemonIfNeeded(source: string) {
  const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
  ensureDaemonStarted(source)
}


export async function GET(req: Request) {
  const endPerf = perf.start('api', 'GET /api/chats')
  const summarized = listChatsForApi()

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  if (!limitParam) {
    endPerf({ count: Object.keys(summarized).length })
    return NextResponse.json(summarized)
  }

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(summarized).sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt))
  const items = all.slice(offset, offset + limit)
  endPerf({ count: items.length, total: all.length })
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function DELETE(req: Request) {
  await ensureDaemonIfNeeded('api/chats:delete')
  const { ids } = await req.json().catch(() => ({ ids: [] })) as { ids: string[] }
  if (!Array.isArray(ids) || !ids.length) {
    return new NextResponse('Missing ids', { status: 400 })
  }
  return NextResponse.json(deleteChats(ids))
}

export async function POST(req: Request) {
  await ensureDaemonIfNeeded('api/chats:post')
  const body = await req.json().catch(() => ({}))
  const result = createChatSession(body as Record<string, unknown>)
  if (!result.session) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.session, { status: result.status })
}
