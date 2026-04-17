import { NextResponse } from 'next/server'
import { clearChatMessagesWithUndo } from '@/lib/server/chats/chat-session-service'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = clearChatMessagesWithUndo(id)
  if (!result.ok) {
    if (result.status === 404) return notFound()
    return NextResponse.json(result.payload, { status: result.status })
  }
  return NextResponse.json(result.payload)
}
