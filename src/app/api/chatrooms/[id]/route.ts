import { NextResponse } from 'next/server'
import { loadChatrooms, saveChatrooms, loadAgents, loadConnectors, saveConnectors } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import { genId } from '@/lib/id'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id]
  if (!chatroom) return notFound()
  return NextResponse.json(chatroom)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id]
  if (!chatroom) return notFound()

  if (body.name !== undefined) chatroom.name = body.name
  if (body.description !== undefined) chatroom.description = body.description
  if (body.chatMode !== undefined) {
    chatroom.chatMode = body.chatMode === 'parallel' ? 'parallel' : 'sequential'
  }
  if (body.autoAddress !== undefined) {
    chatroom.autoAddress = Boolean(body.autoAddress)
  }
  if (body.routingRules !== undefined) {
    chatroom.routingRules = Array.isArray(body.routingRules) ? body.routingRules : undefined
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
    const invalidAgentIds = (body.agentIds as string[]).filter((agentId) => !agents[agentId])
    if (invalidAgentIds.length > 0) {
      return NextResponse.json(
        { error: `Unknown chatroom member(s): ${invalidAgentIds.join(', ')}` },
        { status: 400 },
      )
    }

    const oldIds = new Set(chatroom.agentIds)
    const newIds = new Set(body.agentIds as string[])
    const added = (body.agentIds as string[]).filter((aid: string) => !oldIds.has(aid))
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

    chatroom.agentIds = body.agentIds
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
