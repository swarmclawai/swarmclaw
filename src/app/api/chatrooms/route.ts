import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadChatrooms, saveChatrooms, loadAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { ChatroomCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { z } from 'zod'
import type { Chatroom, ChatroomMessage } from '@/types'
import {
  ensureChatroomRoutingGuidance,
  synthesizeRoutingGuidanceFromRules,
} from '@/lib/server/chatrooms/chatroom-routing'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') || 'chatrooms'
  const chatrooms = loadChatrooms()
  const agents = loadAgents()
  const filtered: typeof chatrooms = {}
  let migrated = false
  for (const [id, chatroom] of Object.entries(chatrooms)) {
    if (chatroom.archivedAt) continue
    if (ensureChatroomRoutingGuidance(chatroom, agents)) migrated = true
    if (filter === 'chatrooms') {
      // Default: exclude hidden (protocol transcript rooms)
      if (chatroom.hidden === true) continue
    } else if (filter === 'protocols') {
      // Only protocol transcript rooms
      if (!chatroom.protocolRunId) continue
    }
    // filter === 'all': include everything except archived
    filtered[id] = chatroom
  }
  if (migrated) saveChatrooms(chatrooms)
  return NextResponse.json(filtered)
}

export async function POST(req: Request) {
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  if (raw && Array.isArray(raw.memberAgentIds) && !Array.isArray(raw.agentIds)) {
    raw.agentIds = raw.memberAgentIds
  }
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
  const routingGuidance = (typeof body.routingGuidance === 'string' && body.routingGuidance.trim())
    ? body.routingGuidance.trim()
    : synthesizeRoutingGuidanceFromRules(body.routingRules, knownAgents)

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
    ...(routingGuidance
      ? { routingGuidance }
      : {}),
    createdAt: now,
    updatedAt: now,
  }

  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')

  return NextResponse.json(chatroom)
}
