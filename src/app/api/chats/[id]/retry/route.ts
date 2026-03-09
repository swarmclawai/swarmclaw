import { NextResponse } from 'next/server'
import { loadSession, upsertSession } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadSession(id)
  if (!session) return notFound()

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
  upsertSession(id, session)

  return NextResponse.json({ message, imagePath })
}
