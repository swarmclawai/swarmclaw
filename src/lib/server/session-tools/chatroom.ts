import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadChatrooms, saveChatrooms, loadAgents } from '../storage'
import { genId } from '@/lib/id'
import { notify } from '../ws-hub'
import type { ToolBuildContext } from './context'
import type { Chatroom } from '@/types'

export function buildChatroomTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { hasTool } = bctx

  if (hasTool('manage_chatrooms')) {
    tools.push(
      tool(
        async ({ action, chatroomId, name, description, agentIds, agentId, message, chatMode, autoAddress }) => {
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
              const invalidAgentIds = requestedAgentIds.filter((aid: string) => !agents[aid])
              if (invalidAgentIds.length > 0) {
                return `Error: unknown agent IDs: ${invalidAgentIds.join(', ')}`
              }
              const validAgentIds = requestedAgentIds
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

            if (!chatroomId) return 'Error: chatroomId is required for this action.'
            const chatroom = chatrooms[chatroomId]
            if (!chatroom) return `Error: chatroom not found: ${chatroomId}`

            if (action === 'add_agent') {
              if (!agentId) return 'Error: agentId is required.'
              const agents = loadAgents()
              if (!agents[agentId]) return `Error: agent not found: ${agentId}`
              if (!chatroom.agentIds.includes(agentId)) {
                chatroom.agentIds.push(agentId)
                chatroom.updatedAt = Date.now()
                chatrooms[chatroomId] = chatroom
                saveChatrooms(chatrooms)
                notify('chatrooms')
                notify(`chatroom:${chatroomId}`)
              }
              return JSON.stringify({ ok: true, agentIds: chatroom.agentIds })
            }

            if (action === 'remove_agent') {
              if (!agentId) return 'Error: agentId is required.'
              chatroom.agentIds = chatroom.agentIds.filter((id: string) => id !== agentId)
              chatroom.updatedAt = Date.now()
              chatrooms[chatroomId] = chatroom
              saveChatrooms(chatrooms)
              notify('chatrooms')
              notify(`chatroom:${chatroomId}`)
              return JSON.stringify({ ok: true, agentIds: chatroom.agentIds })
            }

            if (action === 'list_members') {
              const agents = loadAgents()
              const members = chatroom.agentIds.map((id: string) => {
                const agent = agents[id]
                return agent ? { id, name: agent.name, description: agent.description } : { id, name: 'Unknown' }
              })
              return JSON.stringify(members)
            }

            if (action === 'send_message') {
              if (!message) return 'Error: message is required.'
              const msgId = genId()
              const senderName = bctx.ctx?.agentId
                ? (loadAgents()[bctx.ctx.agentId]?.name || 'Agent')
                : 'Agent'
              chatroom.messages.push({
                id: msgId,
                senderId: bctx.ctx?.agentId || 'agent',
                senderName,
                role: 'assistant' as const,
                text: message,
                mentions: [],
                reactions: [],
                time: Date.now(),
              })
              chatroom.updatedAt = Date.now()
              chatrooms[chatroomId] = chatroom
              saveChatrooms(chatrooms)
              notify(`chatroom:${chatroomId}`)
              return JSON.stringify({ ok: true, messageId: msgId })
            }

            return `Error: unknown action "${action}". Valid actions: list_chatrooms, create_chatroom, add_agent, remove_agent, list_members, send_message`
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'manage_chatrooms',
          description: 'Manage chatrooms for multi-agent collaboration. Actions: list_chatrooms, create_chatroom, add_agent, remove_agent, list_members, send_message.',
          schema: z.object({
            action: z.enum(['list_chatrooms', 'create_chatroom', 'add_agent', 'remove_agent', 'list_members', 'send_message'])
              .describe('The action to perform'),
            chatroomId: z.string().optional().describe('Chatroom ID (required for most actions except list/create)'),
            name: z.string().optional().describe('Chatroom name (for create_chatroom)'),
            description: z.string().optional().describe('Chatroom description (for create_chatroom)'),
            agentIds: z.array(z.string()).optional().describe('Initial agent IDs (for create_chatroom)'),
            chatMode: z.enum(['sequential', 'parallel']).optional().describe('Optional orchestration mode for create_chatroom'),
            autoAddress: z.boolean().optional().describe('Whether to auto-address all members when no @mention is present'),
            agentId: z.string().optional().describe('Agent ID (for add_agent/remove_agent)'),
            message: z.string().optional().describe('Message text (for send_message)'),
          }),
        },
      ),
    )
  }

  return tools
}
