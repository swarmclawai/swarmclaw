import { NextResponse } from 'next/server'
import { clearChatMessages } from '@/lib/server/chats/chat-session-service'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!clearChatMessages(id)) return notFound()
  return new NextResponse('OK')
}
