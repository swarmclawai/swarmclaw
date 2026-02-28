import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return new NextResponse(null, { status: 404 })

  const msgs = session.messages
  // Pop trailing assistant messages to find the last user message
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant') {
    msgs.pop()
  }
  if (!msgs.length) {
    return NextResponse.json({ message: '', imagePath: null }, { status: 200 })
  }

  const lastUser = msgs[msgs.length - 1]
  const message = lastUser.text
  const imagePath = lastUser.imagePath || null

  // Remove the last user message too — it will be re-sent by the client
  msgs.pop()
  saveSessions(sessions)

  return NextResponse.json({ message, imagePath })
}
