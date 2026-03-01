import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()
  return NextResponse.json(sessions[id].messages)
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
