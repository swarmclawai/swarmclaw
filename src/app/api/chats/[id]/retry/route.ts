import { NextResponse } from 'next/server'
import { retryChatTurn } from '@/lib/server/chats/chat-session-service'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = retryChatTurn(id)
  if (!result.ok) return notFound()
  return NextResponse.json({ message: result.message, imagePath: result.imagePath })
}
