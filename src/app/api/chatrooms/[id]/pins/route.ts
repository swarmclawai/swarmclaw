import { NextResponse } from 'next/server'
import { loadChatrooms, saveChatrooms } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import type { Chatroom } from '@/types'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id] as Chatroom | undefined
  if (!chatroom) return notFound()

  const messageId = body.messageId as string
  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 })
  }

  const message = chatroom.messages.find((m) => m.id === messageId)
  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  }

  // Toggle: remove if pinned, add if not
  if (!chatroom.pinnedMessageIds) chatroom.pinnedMessageIds = []
  const idx = chatroom.pinnedMessageIds.indexOf(messageId)
  if (idx >= 0) {
    chatroom.pinnedMessageIds.splice(idx, 1)
  } else {
    chatroom.pinnedMessageIds.push(messageId)
  }

  chatroom.updatedAt = Date.now()
  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${id}`)

  return NextResponse.json(chatroom)
}
