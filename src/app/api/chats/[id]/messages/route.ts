import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()

  const url = new URL(req.url)
  const limitParam = url.searchParams.get('limit')
  const beforeParam = url.searchParams.get('before')

  const allMessages = sessions[id].messages
  const total = allMessages.length

  // If no limit param, return all messages (backward compatible)
  if (!limitParam) {
    return NextResponse.json(allMessages)
  }

  const limit = Math.max(1, Math.min(500, parseInt(limitParam) || 100))
  const before = beforeParam !== null ? parseInt(beforeParam) : total

  // Return `limit` messages ending just before `before` index
  const start = Math.max(0, before - limit)
  const end = Math.max(0, before)
  const messages = allMessages.slice(start, end)

  return NextResponse.json({
    messages,
    total,
    hasMore: start > 0,
    startIndex: start,
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { kind?: string }
  if (body.kind !== 'context-clear') {
    return NextResponse.json({ error: 'Only context-clear kind is supported' }, { status: 400 })
  }
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return notFound()

  session.messages.push({
    role: 'user',
    text: '',
    kind: 'context-clear',
    time: Date.now(),
  })
  saveSessions(sessions)
  return NextResponse.json({ ok: true })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { messageIndex: number; bookmarked: boolean }
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return notFound()

  const { messageIndex, bookmarked } = body
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= session.messages.length) {
    return NextResponse.json({ error: 'Invalid message index' }, { status: 400 })
  }

  session.messages[messageIndex].bookmarked = bookmarked
  saveSessions(sessions)
  return NextResponse.json(session.messages[messageIndex])
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { messageIndex: number }
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return notFound()

  const { messageIndex } = body
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= session.messages.length) {
    return NextResponse.json({ error: 'Invalid message index' }, { status: 400 })
  }

  // Only allow deleting context-clear markers (safety guard)
  if (session.messages[messageIndex].kind !== 'context-clear') {
    return NextResponse.json({ error: 'Only context-clear markers can be removed' }, { status: 400 })
  }

  session.messages.splice(messageIndex, 1)
  saveSessions(sessions)
  return NextResponse.json({ ok: true })
}
