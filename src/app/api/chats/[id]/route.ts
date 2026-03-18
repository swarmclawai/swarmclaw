import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import {
  deleteChatSession,
  getChatSessionForApi,
  updateChatSession,
} from '@/lib/server/chats/chat-session-service'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getChatSessionForApi(id)
  if (!session) return notFound()
  return NextResponse.json(session)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: updates, error } = await safeParseBody(req)
  if (error) return error
  const session = updateChatSession(id, updates as Record<string, unknown>)
  if (!session) return notFound()
  return NextResponse.json(session)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteChatSession(id)) return notFound()
  return new NextResponse('OK')
}
