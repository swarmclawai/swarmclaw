import { NextResponse } from 'next/server'
import { loadChatrooms, saveChatrooms, loadAgents, loadConnectors, saveConnectors } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { genId } from '@/lib/id'
import { isWorkerOnlyAgent } from '@/lib/server/agents/agent-availability'
import {
  ensureChatroomRoutingGuidance,
  synthesizeRoutingGuidanceFromRules,
} from '@/lib/server/chatrooms/chatroom-routing'
import { ChatroomUpdateSchema, formatZodError } from '@/lib/validation/schemas'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id]
  if (!chatroom) return notFound()
  const agents = loadAgents()
  if (ensureChatroomRoutingGuidance(chatroom, agents)) {
    chatrooms[id] = chatroom
    saveChatrooms(chatrooms)
  }
  return NextResponse.json(chatroom)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = ChatroomUpdateSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })

  const rawKeys = new Set(Object.keys(raw ?? {}))
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (rawKeys.has(key)) body[key] = value
  }

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id]
  if (!chatroom) return notFound()

  if (body.name !== undefined) chatroom.name = body.name as string
  if (body.description !== undefined) chatroom.description = body.description as string
  if (body.chatMode !== undefined) {
    chatroom.chatMode = body.chatMode === 'parallel' ? 'parallel' : 'sequential'
  }
  if (body.autoAddress !== undefined) {
    chatroom.autoAddress = Boolean(body.autoAddress)
  }
  if (body.routingGuidance !== undefined || body.routingRules !== undefined) {
    const agents = loadAgents()
    const routingGuidance = (typeof body.routingGuidance === 'string' && body.routingGuidance.trim())
      ? body.routingGuidance.trim()
      : synthesizeRoutingGuidanceFromRules(
          Array.isArray(body.routingRules) ? body.routingRules : undefined,
          agents,
        )
    chatroom.routingGuidance = routingGuidance
    delete chatroom.routingRules
  }

  // Diff agentIds and inject join/leave system messages
  if (Array.isArray(body.agentIds)) {
    if (body.agentIds.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one chatroom member.' },
        { status: 400 },
      )
    }
    const agents = loadAgents()
    const agentIds = (body.agentIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    const invalidAgentIds = agentIds.filter((agentId) => !agents[agentId])
    if (invalidAgentIds.length > 0) {
      return NextResponse.json(
        { error: `Unknown chatroom member(s): ${invalidAgentIds.join(', ')}` },
        { status: 400 },
      )
    }
    const cliAgentNames = agentIds
      .filter((agentId) => isWorkerOnlyAgent(agents[agentId]))
      .map((agentId) => agents[agentId]?.name || agentId)
    if (cliAgentNames.length > 0) {
      return NextResponse.json(
        { error: `CLI-based agents cannot join chatrooms: ${cliAgentNames.join(', ')}. They can only be used for direct chats and delegation.` },
        { status: 400 },
      )
    }

    const oldIds = new Set(chatroom.agentIds)
    const newIds = new Set(agentIds)
    const added = agentIds.filter((aid: string) => !oldIds.has(aid))
    const removed = chatroom.agentIds.filter((aid: string) => !newIds.has(aid))

    if (added.length > 0 || removed.length > 0) {
      if (!Array.isArray(chatroom.messages)) chatroom.messages = []
      const now = Date.now()
      let offset = 0
      for (const aid of added) {
        chatroom.messages.push({
          id: genId(),
          senderId: 'system',
          senderName: 'System',
          role: 'assistant',
          text: `${agents[aid]?.name || 'Unknown agent'} has joined the chat`,
          mentions: [],
          reactions: [],
          time: now + offset++,
        })
      }
      for (const aid of removed) {
        chatroom.messages.push({
          id: genId(),
          senderId: 'system',
          senderName: 'System',
          role: 'assistant',
          text: `${agents[aid]?.name || 'Unknown agent'} has left the chat`,
          mentions: [],
          reactions: [],
          time: now + offset++,
        })
      }
    }

    chatroom.agentIds = agentIds
  }

  if (body.routingGuidance === undefined && body.routingRules === undefined) {
    ensureChatroomRoutingGuidance(chatroom, loadAgents())
  }

  chatroom.updatedAt = Date.now()

  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${id}`)
  return NextResponse.json(chatroom)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const chatrooms = loadChatrooms()
  if (!chatrooms[id]) return notFound()

  // Cascade: null out chatroomId on any connectors that reference this chatroom
  const connectors = loadConnectors()
  let connectorsDirty = false
  for (const rawConnector of Object.values(connectors)) {
    if (!rawConnector || typeof rawConnector !== 'object') continue
    const connector = rawConnector as { chatroomId?: string | null; updatedAt?: number }
    if (connector.chatroomId !== id) continue
    connector.chatroomId = null
    connector.updatedAt = Date.now()
    connectorsDirty = true
  }
  if (connectorsDirty) {
    saveConnectors(connectors)
    notify('connectors')
  }

  delete chatrooms[id]
  saveChatrooms(chatrooms)
  notify('chatrooms')
  return NextResponse.json({ ok: true })
}
