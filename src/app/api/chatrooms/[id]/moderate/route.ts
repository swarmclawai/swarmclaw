import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadChatrooms, saveChatrooms, appendModerationLog } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import { getMembers } from '@/lib/server/chatrooms/chatroom-helpers'
import type { Chatroom, ChatroomMember } from '@/types'

export const dynamic = 'force-dynamic'

interface ModerationBody {
  action: 'delete-message' | 'mute' | 'unmute' | 'set-role'
  targetAgentId: string
  messageId?: string
  role?: 'admin' | 'moderator' | 'member'
  muteDurationMinutes?: number
}

function isValidAction(action: unknown): action is ModerationBody['action'] {
  return typeof action === 'string' && ['delete-message', 'mute', 'unmute', 'set-role'].includes(action)
}

function isValidRole(role: unknown): role is ChatroomMember['role'] {
  return typeof role === 'string' && ['admin', 'moderator', 'member'].includes(role)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as Record<string, unknown>

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id] as Chatroom | undefined
  if (!chatroom) return notFound()

  const action = body.action
  const targetAgentId = typeof body.targetAgentId === 'string' ? body.targetAgentId : ''

  if (!isValidAction(action)) {
    return NextResponse.json({ error: 'Invalid action. Must be: delete-message, mute, unmute, or set-role' }, { status: 400 })
  }
  if (!targetAgentId) {
    return NextResponse.json({ error: 'targetAgentId is required' }, { status: 400 })
  }
  if (!chatroom.agentIds.includes(targetAgentId)) {
    return NextResponse.json({ error: 'Agent is not a member of this chatroom' }, { status: 400 })
  }

  // Ensure members array exists (backward compat)
  if (!chatroom.members) {
    chatroom.members = getMembers(chatroom)
  }

  const logId = crypto.randomBytes(8).toString('hex')

  switch (action) {
    case 'delete-message': {
      const messageId = typeof body.messageId === 'string' ? body.messageId : ''
      if (!messageId) {
        return NextResponse.json({ error: 'messageId is required for delete-message' }, { status: 400 })
      }
      const msgIndex = chatroom.messages.findIndex((m) => m.id === messageId)
      if (msgIndex === -1) {
        return NextResponse.json({ error: 'Message not found' }, { status: 404 })
      }
      const deleted = chatroom.messages.splice(msgIndex, 1)[0]
      // Also remove from pinned if it was pinned
      if (chatroom.pinnedMessageIds) {
        chatroom.pinnedMessageIds = chatroom.pinnedMessageIds.filter((pid) => pid !== messageId)
      }
      appendModerationLog(logId, {
        id: logId,
        chatroomId: id,
        action: 'delete-message',
        targetAgentId,
        messageId,
        messagePreview: deleted.text.slice(0, 100),
        timestamp: Date.now(),
      })
      break
    }

    case 'mute': {
      const minutes = typeof body.muteDurationMinutes === 'number' && body.muteDurationMinutes > 0
        ? body.muteDurationMinutes
        : 30
      const mutedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString()
      const memberIdx = chatroom.members.findIndex((m) => m.agentId === targetAgentId)
      if (memberIdx >= 0) {
        chatroom.members[memberIdx].mutedUntil = mutedUntil
      } else {
        chatroom.members.push({ agentId: targetAgentId, role: 'member', mutedUntil })
      }
      appendModerationLog(logId, {
        id: logId,
        chatroomId: id,
        action: 'mute',
        targetAgentId,
        muteDurationMinutes: minutes,
        mutedUntil,
        timestamp: Date.now(),
      })
      break
    }

    case 'unmute': {
      const memberIdx = chatroom.members.findIndex((m) => m.agentId === targetAgentId)
      if (memberIdx >= 0) {
        delete chatroom.members[memberIdx].mutedUntil
      }
      appendModerationLog(logId, {
        id: logId,
        chatroomId: id,
        action: 'unmute',
        targetAgentId,
        timestamp: Date.now(),
      })
      break
    }

    case 'set-role': {
      const role = body.role
      if (!isValidRole(role)) {
        return NextResponse.json({ error: 'role must be: admin, moderator, or member' }, { status: 400 })
      }
      const memberIdx = chatroom.members.findIndex((m) => m.agentId === targetAgentId)
      if (memberIdx >= 0) {
        chatroom.members[memberIdx].role = role
      } else {
        chatroom.members.push({ agentId: targetAgentId, role })
      }
      appendModerationLog(logId, {
        id: logId,
        chatroomId: id,
        action: 'set-role',
        targetAgentId,
        role,
        timestamp: Date.now(),
      })
      break
    }
  }

  chatroom.updatedAt = Date.now()
  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${id}`)

  return NextResponse.json(chatroom)
}
