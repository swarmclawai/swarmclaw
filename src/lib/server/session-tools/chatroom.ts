import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadChatrooms, saveChatrooms, loadAgents } from '../storage'
import { genId } from '@/lib/id'
import { notify } from '../ws-hub'
import type { ToolBuildContext } from './context'
import type { Chatroom, Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '../logger'
import { debug } from '../debug'
import { logExecution } from '../execution-log'
import { logActivity } from '../storage'

/**
 * Core Chatroom Execution Logic
 */
/** Map short action aliases LLMs commonly send to canonical action names */
const ACTION_ALIASES: Record<string, string> = {
  list: 'list_chatrooms',
  create: 'create_chatroom',
  add: 'add_agent',
  remove: 'remove_agent',
  members: 'list_members',
  send: 'send_message',
  rooms: 'my_rooms',
  messages: 'read_messages',
  mentions: 'my_mentions',
}

/** Parse a value that might be a JSON-stringified array */
function coerceStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed } catch { /* ignore */ }
    }
  }
  return undefined
}

async function executeChatroomAction(args: Record<string, unknown>, context: { agentId?: string | null }) {
  const normalized = normalizeToolInputArgs(args)
  const rawAction = normalized.action as string
  const action = ACTION_ALIASES[rawAction] || rawAction
  const chatroomId = (normalized.chatroomId ?? normalized.chatroom_id) as string | undefined
  const name = normalized.name as string | undefined
  const description = normalized.description as string | undefined
  const agentIds = coerceStringArray(normalized.agentIds ?? normalized.agent_ids)
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const message = (normalized.message ?? normalized.text) as string | undefined
  const chatMode = (normalized.chatMode ?? normalized.chat_mode) as string | undefined
  const autoAddress = (normalized.autoAddress ?? normalized.auto_address) as boolean | undefined
  const temporary = (normalized.temporary) as boolean | undefined
  const topic = (normalized.topic) as string | undefined
  const triggerResponses = (normalized.triggerResponses ?? normalized.trigger_responses) as boolean | undefined
  const targetAgentId = (normalized.targetAgentId ?? normalized.target_agent_id) as string | undefined
  const limit = typeof normalized.limit === 'number' ? normalized.limit : undefined
  try {
    const chatrooms = loadChatrooms() as Record<string, Chatroom>

    if (action === 'list_chatrooms') {
      const list = Object.values(chatrooms).map((cr) => ({
        id: cr.id,
        name: cr.name,
        description: cr.description,
        memberCount: cr.agentIds.length,
        messageCount: cr.messages.length,
      }))
      return JSON.stringify(list)
    }

    if (action === 'create_chatroom') {
      const id = genId()
      const agents = loadAgents()
      const requestedAgentIds = agentIds || []
      const validAgentIds = requestedAgentIds.filter((aid: string) => !!agents[aid])

      const chatroom: Chatroom = {
        id,
        name: name || 'New Chatroom',
        description: description || '',
        agentIds: validAgentIds,
        messages: [],
        chatMode: chatMode === 'parallel' ? 'parallel' : 'sequential',
        autoAddress: Boolean(autoAddress),
        temporary: !!temporary,
        topic: topic || undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      chatrooms[id] = chatroom
      saveChatrooms(chatrooms)
      notify('chatrooms')

      const sid = context.agentId || ''
      log.info('chatroom', 'Created', { chatroomId: id, name: chatroom.name, members: validAgentIds.length })
      logExecution(sid, 'chatroom_message', `Chatroom created: ${chatroom.name}`, {
        detail: { chatroomId: id, members: validAgentIds },
      })
      logActivity({
        entityType: 'chatroom',
        entityId: id,
        action: 'created',
        actor: 'agent',
        actorId: context.agentId || undefined,
        summary: `Chatroom created: ${chatroom.name} (${validAgentIds.length} members)`,
      })

      return JSON.stringify({ ok: true, chatroom: { id, name: chatroom.name, agentIds: validAgentIds } })
    }

    // --- Self-awareness actions (no chatroomId required) ---

    if (action === 'my_rooms') {
      const selfId = context.agentId
      if (!selfId) return 'Error: no agent context available.'
      const agents = loadAgents()
      const myRooms = Object.values(chatrooms)
        .filter((cr) => cr.agentIds.includes(selfId) && !cr.archivedAt)
        .map((cr) => {
          const lastMsg = cr.messages[cr.messages.length - 1]
          return {
            id: cr.id,
            name: cr.name,
            memberCount: cr.agentIds.length,
            lastMessage: lastMsg
              ? { sender: lastMsg.senderName, text: lastMsg.text.slice(0, 120), time: lastMsg.time }
              : null,
            members: cr.agentIds.map((aid) => agents[aid]?.name || aid).slice(0, 8),
          }
        })
      return JSON.stringify(myRooms)
    }

    if (action === 'my_mentions') {
      const selfId = context.agentId
      if (!selfId) return 'Error: no agent context available.'
      const maxResults = Math.min(limit || 10, 50)
      const mentions: Array<{
        chatroomId: string
        chatroomName: string
        messageId: string
        sender: string
        text: string
        time: number
        targeted: boolean
      }> = []
      for (const cr of Object.values(chatrooms)) {
        if (cr.archivedAt) continue
        if (!cr.agentIds.includes(selfId)) continue
        for (let i = cr.messages.length - 1; i >= 0 && mentions.length < maxResults; i--) {
          const msg = cr.messages[i]
          if (msg.senderId === selfId) continue
          const isMentioned = msg.mentions?.includes(selfId)
          const isTargeted = msg.targetAgentId === selfId
          if (isMentioned || isTargeted) {
            mentions.push({
              chatroomId: cr.id,
              chatroomName: cr.name,
              messageId: msg.id,
              sender: msg.senderName,
              text: msg.text.slice(0, 200),
              time: msg.time,
              targeted: isTargeted,
            })
          }
        }
      }
      mentions.sort((a, b) => b.time - a.time)
      return JSON.stringify(mentions.slice(0, maxResults))
    }

    // --- Actions requiring chatroomId ---

    if (action === 'read_messages') {
      // read_messages can work with or without chatroomId
      if (!chatroomId) return 'Error: chatroomId is required.'
      const chatroom = chatrooms[chatroomId]
      if (!chatroom) return 'Error: chatroom not found.'
      const maxMessages = Math.min(limit || 20, 50)
      const selfId = context.agentId
      const messages = chatroom.messages.slice(-maxMessages).map((msg) => ({
        id: msg.id,
        sender: msg.senderName,
        senderId: msg.senderId,
        text: msg.text.slice(0, 300),
        time: msg.time,
        ...(msg.targetAgentId ? { targetAgentId: msg.targetAgentId } : {}),
        ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
        forMe: msg.targetAgentId === selfId || msg.mentions?.includes(selfId || '') || false,
      }))
      return JSON.stringify(messages)
    }

    if (!chatroomId) return 'Error: chatroomId is required.'
    const chatroom = chatrooms[chatroomId]
    if (!chatroom) return 'Error: chatroom not found.'

    if (action === 'add_agent') {
      if (!agentId) return 'Error: agentId required.'
      if (!chatroom.agentIds.includes(agentId)) {
        chatroom.agentIds.push(agentId)
        chatroom.updatedAt = Date.now()
        saveChatrooms(chatrooms)
        notify('chatrooms'); notify(`chatroom:${chatroomId}`)
      }
      return JSON.stringify({ ok: true, agentIds: chatroom.agentIds })
    }

    if (action === 'remove_agent') {
      if (!agentId) return 'Error: agentId required.'
      chatroom.agentIds = chatroom.agentIds.filter((id: string) => id !== agentId)
      chatroom.updatedAt = Date.now()
      saveChatrooms(chatrooms)
      notify('chatrooms'); notify(`chatroom:${chatroomId}`)
      return JSON.stringify({ ok: true, agentIds: chatroom.agentIds })
    }

    if (action === 'list_members') {
      const agents = loadAgents()
      const members = chatroom.agentIds.map((id: string) => ({
        id,
        name: agents[id]?.name || 'Unknown',
      }))
      return JSON.stringify(members)
    }

    if (action === 'send_message') {
      if (!message) return 'Error: message required.'
      const msgId = genId()
      const agents = loadAgents()
      const senderName = context.agentId ? (agents[context.agentId]?.name || 'Agent') : 'Agent'
      chatroom.messages.push({
        id: msgId,
        senderId: context.agentId || 'agent',
        senderName,
        role: 'assistant' as const,
        text: message,
        mentions: [],
        reactions: [],
        time: Date.now(),
        ...(targetAgentId ? { targetAgentId } : {}),
      })
      chatroom.updatedAt = Date.now()
      saveChatrooms(chatrooms)
      notify(`chatroom:${chatroomId}`)

      const sid = context.agentId || ''
      logExecution(sid, 'chatroom_message', `Message sent in ${chatroom.name}`, {
        detail: { chatroomId, senderId: context.agentId, messageLen: message.length },
      })
      debug.verbose('chatroom', 'Content', { chatroomId, message })

      // Trigger other agents to respond via the chatroom chat API
      if (triggerResponses !== false) {
        try {
          const port = process.env.PORT || '3456'
          const key = process.env.ACCESS_KEY || ''
          await fetch(`http://127.0.0.1:${port}/api/chatrooms/${chatroomId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Access-Key': key },
            body: JSON.stringify({ text: message, senderId: context.agentId || 'agent' }),
          })
        } catch { /* best-effort */ }
      }

      return JSON.stringify({ ok: true, messageId: msgId })
    }

    return `Unknown action "${action}".`
  } catch (err: unknown) {
    log.warn('chatroom', 'Action failed', { action, error: errorMessage(err) })
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Extension
 */
const ACTIONS = [
  'list_chatrooms', 'create_chatroom', 'add_agent', 'remove_agent',
  'list_members', 'send_message', 'my_rooms', 'read_messages', 'my_mentions',
] as const

const ChatroomExtension: Extension = {
  name: 'Core Chatrooms',
  description: 'Manage SwarmClaw routing rules and multi-agent chatrooms.',
  hooks: {
    getCapabilityDescription: () => 'I can create and participate in chatrooms (`manage_chatrooms`) for multi-agent collaboration with @mention-based discussions. I can check my chatroom memberships (my_rooms), read messages (read_messages), and find messages addressed to me (my_mentions).',
    getOperatingGuidance: () => 'To share context across agents in a chatroom or protocol, use memory_store with scope "global" or explicit sharedWith agent IDs.',
  } as ExtensionHooks,
  tools: [
    {
      name: 'manage_chatrooms',
      description: [
        'Manage multi-agent chatrooms and collaboration.',
        'Actions: list_chatrooms, create_chatroom (name, agentIds), add_agent (chatroomId, agentId),',
        'remove_agent (chatroomId, agentId), list_members (chatroomId), send_message (chatroomId, message, targetAgentId?),',
        'my_rooms (list chatrooms I belong to), read_messages (chatroomId, limit?),',
        'my_mentions (messages addressed to me across chatrooms, limit?).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          chatroomId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          agentId: { type: 'string' },
          agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to add as members when creating a chatroom' },
          message: { type: 'string' },
          chatMode: { type: 'string', enum: ['sequential', 'parallel'] },
          autoAddress: { type: 'boolean' },
          temporary: { type: 'boolean', description: 'If true, marks the chatroom as a temporary orchestrator session' },
          topic: { type: 'string', description: 'Topic or objective for the chatroom' },
          triggerResponses: { type: 'boolean', description: 'If true (default), sending a message triggers other agents to respond' },
          targetAgentId: { type: 'string', description: 'Tag a message for a specific agent without @mentioning' },
          limit: { type: 'number', description: 'Max messages to return (default 20, max 50)' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeChatroomAction(args, { agentId: context.session.agentId }),
    },
  ],
}

registerNativeCapability('chatroom', ChatroomExtension)

/**
 * Legacy Bridge
 */
export function buildChatroomTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('manage_chatrooms')) return []
  return [
    tool(
      async (args) => executeChatroomAction(args, { agentId: bctx.ctx?.agentId }),
      {
        name: 'manage_chatrooms',
        description: ChatroomExtension.tools![0].description,
        schema: z.object({
          action: z.enum([...ACTIONS])
            .describe('The chatroom action to perform'),
          chatroomId: z.string().optional().describe('Required for add_agent, remove_agent, list_members, send_message, read_messages'),
          name: z.string().optional(),
          description: z.string().optional(),
          agentIds: z.array(z.string()).optional(),
          agentId: z.string().optional(),
          message: z.string().optional(),
          chatMode: z.enum(['sequential', 'parallel']).optional(),
          autoAddress: z.boolean().optional(),
          targetAgentId: z.string().optional().describe('Tag a message for a specific agent'),
          limit: z.number().optional().describe('Max messages to return'),
        }).passthrough(),
      },
    ),
  ]
}
