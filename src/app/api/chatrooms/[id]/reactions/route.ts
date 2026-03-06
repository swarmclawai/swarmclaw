import { NextResponse } from 'next/server'
import { loadChatrooms, saveChatrooms } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import type { Chatroom, ChatroomMessage, ChatroomReaction } from '@/types'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id] as Chatroom | undefined
  if (!chatroom) return notFound()

  const messageId = body.messageId as string
  const emoji = body.emoji as string
  const reactorId = (body.reactorId as string) || 'user'
  if (!messageId || !emoji) {
    return NextResponse.json({ error: 'messageId and emoji are required' }, { status: 400 })
  }

  const message = chatroom.messages.find((m: ChatroomMessage) => m.id === messageId)
  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  }

  // Toggle: remove if already exists, add if not
  const existingIdx = message.reactions.findIndex(
    (r: ChatroomReaction) => r.emoji === emoji && r.reactorId === reactorId
  )
  if (existingIdx >= 0) {
    message.reactions.splice(existingIdx, 1)
  } else {
    message.reactions.push({ emoji, reactorId, time: Date.now() })
  }

  chatroom.updatedAt = Date.now()
  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${id}`)

  return NextResponse.json(chatroom)
}
