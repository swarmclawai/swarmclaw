import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadChatrooms, saveChatrooms, loadAgents } from '../storage'
import { genId } from '@/lib/id'
import { notify } from '../ws-hub'
import type { ToolBuildContext } from './context'
import type { Chatroom, Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Core Chatroom Execution Logic
 */
async function executeChatroomAction(args: Record<string, unknown>, context: { agentId?: string | null }) {
  const normalized = normalizeToolInputArgs(args)
  const action = normalized.action as string
  const chatroomId = (normalized.chatroomId ?? normalized.chatroom_id) as string | undefined
  const name = normalized.name as string | undefined
  const description = normalized.description as string | undefined
  const agentIds = (normalized.agentIds ?? normalized.agent_ids) as string[] | undefined
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const message = (normalized.message ?? normalized.text) as string | undefined
  const chatMode = (normalized.chatMode ?? normalized.chat_mode) as string | undefined
  const autoAddress = (normalized.autoAddress ?? normalized.auto_address) as boolean | undefined
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      chatrooms[id] = chatroom
      saveChatrooms(chatrooms)
      notify('chatrooms')
      return JSON.stringify({ ok: true, chatroom: { id, name: chatroom.name, agentIds: validAgentIds } })
    }

    if (!chatroomId) return 'Error: chatroomId is required.'
    const chatroom = chatrooms[chatroomId]
    if (!chatroom) return `Error: chatroom not found.`

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
      })
      chatroom.updatedAt = Date.now()
      saveChatrooms(chatrooms)
      notify(`chatroom:${chatroomId}`)
      return JSON.stringify({ ok: true, messageId: msgId })
    }

    return `Unknown action "${action}".`
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const ChatroomPlugin: Plugin = {
  name: 'Core Chatrooms',
  description: 'Manage SwarmClaw routing rules and multi-agent chatrooms.',
  hooks: {
    getCapabilityDescription: () => 'I can create and participate in chatrooms (`manage_chatrooms`) for multi-agent collaboration with @mention-based discussions.',
  } as PluginHooks,
  tools: [
    {
      name: 'manage_chatrooms',
      description: 'Manage multi-agent chatrooms and collaboration.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_chatrooms', 'create_chatroom', 'add_agent', 'remove_agent', 'list_members', 'send_message'] },
          chatroomId: { type: 'string' },
          name: { type: 'string' },
          agentId: { type: 'string' },
          message: { type: 'string' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeChatroomAction(args, { agentId: context.session.agentId })
    }
  ]
}

getPluginManager().registerBuiltin('chatroom', ChatroomPlugin)

/**
 * Legacy Bridge
 */
export function buildChatroomTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('manage_chatrooms')) return []
  return [
    tool(
      async (args) => executeChatroomAction(args, { agentId: bctx.ctx?.agentId }),
      {
        name: 'manage_chatrooms',
        description: ChatroomPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
