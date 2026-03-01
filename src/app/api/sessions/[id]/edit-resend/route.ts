import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { messageIndex: number; newText: string }
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return notFound()

  const { messageIndex, newText } = body
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= session.messages.length) {
    return NextResponse.json({ error: 'Invalid message index' }, { status: 400 })
  }

  // Truncate messages to messageIndex (discard that msg + everything after)
  session.messages = session.messages.slice(0, messageIndex)
  saveSessions(sessions)

  return NextResponse.json({ message: newText })
}
