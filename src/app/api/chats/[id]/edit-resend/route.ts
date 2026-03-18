import { NextResponse } from 'next/server'
import { editAndResendChatTurn } from '@/lib/server/chats/chat-session-service'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { messageIndex: number; newText: string }
  const result = editAndResendChatTurn(id, body.messageIndex, body.newText)
  if (!result.ok) {
    return result.status === 404
      ? notFound()
      : NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json({ message: result.message })
}
