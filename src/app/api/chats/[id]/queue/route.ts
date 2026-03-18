import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import {
  cancelQueuedChatMessages,
  getQueueSnapshot,
  queueChatMessage,
} from '@/lib/server/chats/chat-session-service'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const snapshot = getQueueSnapshot(id)
  if (!snapshot) return notFound()
  return NextResponse.json(snapshot)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const result = queueChatMessage(id, body as Record<string, unknown>)
  if ('error' in result) {
    return result.status === 404
      ? notFound()
      : NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.payload, { status: result.status })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const result = cancelQueuedChatMessages(id, typeof body.runId === 'string' ? body.runId : '')
  if (!result) return notFound()
  return NextResponse.json(result.payload, { status: result.status })
}
