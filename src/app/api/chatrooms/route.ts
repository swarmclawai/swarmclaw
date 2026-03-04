import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadChatrooms, saveChatrooms, loadAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { ChatroomCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
import type { Chatroom, ChatroomMessage } from '@/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  const chatrooms = loadChatrooms()
  return NextResponse.json(chatrooms)
}

export async function POST(req: Request) {
  const raw = await req.json()
  const parsed = ChatroomCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data
  const chatrooms = loadChatrooms()
  const id = genId()

  const requestedAgentIds: string[] = body.agentIds
  const knownAgents = loadAgents()
  const invalidAgentIds = requestedAgentIds.filter((agentId) => !knownAgents[agentId])
  if (invalidAgentIds.length > 0) {
    return NextResponse.json(
      { error: `Unknown chatroom member(s): ${invalidAgentIds.join(', ')}` },
      { status: 400 },
    )
  }
  const agentIds: string[] = requestedAgentIds
  const chatMode = body.chatMode === 'parallel' ? 'parallel' : 'sequential'
  const autoAddress = Boolean(body.autoAddress)
  const now = Date.now()

  // Generate join messages for initial agents
  const agents = agentIds.length > 0 ? knownAgents : {}
  const joinMessages: ChatroomMessage[] = agentIds.map((agentId: string, i: number) => ({
    id: genId(),
    senderId: 'system',
    senderName: 'System',
    role: 'assistant',
    text: `${agents[agentId]?.name || 'Unknown agent'} has joined the chat`,
    mentions: [],
    reactions: [],
    time: now + i, // offset by 1ms so they sort in order
  }))

  const chatroom: Chatroom = {
    id,
    name: body.name || 'New Chatroom',
    description: body.description || '',
    agentIds,
    messages: joinMessages,
    chatMode,
    autoAddress,
    ...(Array.isArray(body.routingRules) && body.routingRules.length > 0
      ? { routingRules: body.routingRules }
      : {}),
    createdAt: now,
    updatedAt: now,
  }

  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')

  return NextResponse.json(chatroom)
}
