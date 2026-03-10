'use client'

import { create } from 'zustand'
import { api, getStoredAccessKey } from '@/lib/app/api-client'
import type { Chatroom, ChatroomMessage, ChatroomRoutingRule, SSEEvent } from '@/types'
import type { PendingFile } from '@/stores/use-chat-store'

interface ToolEvent {
  name: string
  input: string
  output?: string
}

export interface StreamingAgent {
  text: string
  name: string
  error?: string
  toolEvents: ToolEvent[]
}

interface QueuedChatroomMessage {
  id: string
  chatroomId: string
  text: string
  pendingFiles: PendingFile[]
  replyingTo: ChatroomMessage | null
}

function nextQueuedId() {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface ChatroomState {
  chatrooms: Record<string, Chatroom>
  currentChatroomId: string | null
  streaming: boolean
  streamingAgents: Map<string, StreamingAgent>
  chatroomSheetOpen: boolean
  editingChatroomId: string | null

  // File uploads
  pendingFiles: PendingFile[]
  addPendingFile: (f: PendingFile) => void
  removePendingFile: (index: number) => void
  clearPendingFiles: () => void

  // Reply-to
  replyingTo: ChatroomMessage | null
  setReplyingTo: (msg: ChatroomMessage | null) => void

  queuedMessages: QueuedChatroomMessage[]
  removeQueuedMessage: (id: string) => void
  shiftQueuedMessage: () => QueuedChatroomMessage | undefined

  loadChatrooms: () => Promise<void>
  createChatroom: (data: { name: string; description?: string; agentIds?: string[]; chatMode?: 'sequential' | 'parallel'; autoAddress?: boolean; routingRules?: ChatroomRoutingRule[] }) => Promise<Chatroom>
  updateChatroom: (id: string, data: Partial<Chatroom>) => Promise<void>
  deleteChatroom: (id: string) => Promise<void>
  setCurrentChatroom: (id: string | null) => void
  sendMessage: (text: string) => Promise<void>
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  togglePin: (messageId: string) => Promise<void>
  addMember: (agentId: string) => Promise<void>
  removeMember: (agentId: string) => Promise<void>
  setChatroomSheetOpen: (open: boolean) => void
  setEditingChatroomId: (id: string | null) => void

  // Moderation
  deleteMessage: (messageId: string, targetAgentId: string) => Promise<void>
  muteAgent: (targetAgentId: string, minutes?: number) => Promise<void>
  unmuteAgent: (targetAgentId: string) => Promise<void>
  setMemberRole: (targetAgentId: string, role: 'admin' | 'moderator' | 'member') => Promise<void>
}

export const useChatroomStore = create<ChatroomState>((set, get) => ({
  chatrooms: {},
  currentChatroomId: null,
  streaming: false,
  streamingAgents: new Map(),
  chatroomSheetOpen: false,
  editingChatroomId: null,

  // File uploads
  pendingFiles: [],
  addPendingFile: (f) => set((s) => ({ pendingFiles: [...s.pendingFiles, f] })),
  removePendingFile: (index) => set((s) => ({ pendingFiles: s.pendingFiles.filter((_, i) => i !== index) })),
  clearPendingFiles: () => set({ pendingFiles: [] }),

  // Reply-to
  replyingTo: null,
  setReplyingTo: (msg) => set({ replyingTo: msg }),
  queuedMessages: [],
  removeQueuedMessage: (id) => set((s) => ({ queuedMessages: s.queuedMessages.filter((item) => item.id !== id) })),
  shiftQueuedMessage: () => {
    const queue = get().queuedMessages
    if (!queue.length) return undefined
    const next = queue[0]
    set({ queuedMessages: queue.slice(1) })
    return next
  },

  loadChatrooms: async () => {
    const chatrooms = await api<Record<string, Chatroom>>('GET', '/chatrooms')
    set({ chatrooms })
  },

  createChatroom: async (data) => {
    const chatroom = await api<Chatroom>('POST', '/chatrooms', data)
    set((s) => ({ chatrooms: { ...s.chatrooms, [chatroom.id]: chatroom } }))
    return chatroom
  },

  updateChatroom: async (id, data) => {
    const chatroom = await api<Chatroom>('PUT', `/chatrooms/${id}`, data)
    set((s) => ({ chatrooms: { ...s.chatrooms, [id]: chatroom } }))
  },

  deleteChatroom: async (id) => {
    await api('DELETE', `/chatrooms/${id}`)
    set((s) => {
      const chatrooms = { ...s.chatrooms }
      delete chatrooms[id]
      return {
        chatrooms,
        currentChatroomId: s.currentChatroomId === id ? null : s.currentChatroomId,
      }
    })
  },

  setCurrentChatroom: (id) => set({ currentChatroomId: id }),

  sendMessage: async (text) => {
    const { currentChatroomId, streaming, pendingFiles, replyingTo } = get()
    if (!currentChatroomId || (!text.trim() && !pendingFiles.length)) return
    const targetChatroomId = currentChatroomId

    if (streaming) {
      set((s) => ({
        queuedMessages: [
          ...s.queuedMessages,
          {
            id: nextQueuedId(),
            chatroomId: targetChatroomId,
            text,
            pendingFiles: [...pendingFiles],
            replyingTo,
          },
        ],
        pendingFiles: [],
        replyingTo: null,
      }))
      return
    }

    const imagePath = pendingFiles.length > 0 && pendingFiles[0].file.type.startsWith('image/')
      ? pendingFiles[0].path
      : undefined
    const attachedFiles = pendingFiles.length > 0
      ? pendingFiles.map((f) => f.path)
      : undefined
    const optimisticText = text.trim() || 'See attached file(s).'
    let started = false

    const key = getStoredAccessKey()
    try {
      const res = await fetch(`/api/chatrooms/${targetChatroomId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Access-Key': key } : {}),
        },
        body: JSON.stringify({
          text,
          ...(imagePath ? { imagePath } : {}),
          ...(attachedFiles ? { attachedFiles } : {}),
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
        }),
      })

      if (!res.ok || !res.body) {
        return
      }

      started = true
      set((s) => {
        const existingChatroom = s.chatrooms[targetChatroomId]
        const optimisticMessage: ChatroomMessage = {
          id: `local-${Date.now()}`,
          senderId: 'user',
          senderName: 'You',
          role: 'user',
          text: optimisticText,
          mentions: [],
          reactions: [],
          time: Date.now(),
          ...(imagePath ? { imagePath } : {}),
          ...(attachedFiles ? { attachedFiles } : {}),
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
        }
        return {
          streaming: true,
          streamingAgents: new Map(),
          pendingFiles: [],
          replyingTo: null,
          chatrooms: existingChatroom
            ? {
                ...s.chatrooms,
                [targetChatroomId]: {
                  ...existingChatroom,
                  messages: [...existingChatroom.messages, optimisticMessage],
                  updatedAt: optimisticMessage.time,
                },
              }
            : s.chatrooms,
        }
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent
            const agentId = event.agentId
            const agentName = event.agentName

            if (event.t === 'cr_agent_start' && agentId && agentName) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                agents.set(agentId, { text: '', name: agentName, toolEvents: [] })
                return { streamingAgents: agents }
              })
            } else if (event.t === 'tool_call' && agentId && event.toolName) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, {
                    ...existing,
                    toolEvents: [...existing.toolEvents, { name: event.toolName!, input: event.toolInput || '' }],
                  })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'tool_result' && agentId) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing && existing.toolEvents.length > 0) {
                  const updatedEvents = [...existing.toolEvents]
                  const last = updatedEvents[updatedEvents.length - 1]
                  updatedEvents[updatedEvents.length - 1] = { ...last, output: event.toolOutput || event.text || '' }
                  agents.set(agentId, { ...existing, toolEvents: updatedEvents })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'd' && agentId && event.text) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, { ...existing, text: existing.text + event.text })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'err' && agentId && event.text) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, { ...existing, error: event.text })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'cr_agent_done' && agentId) {
              const currentAgent = get().streamingAgents.get(agentId)
              if (currentAgent?.error) {
                setTimeout(() => {
                  set((s) => {
                    const agents = new Map(s.streamingAgents)
                    agents.delete(agentId)
                    return { streamingAgents: agents }
                  })
                }, 4000)
              } else {
                set((s) => {
                  const agents = new Map(s.streamingAgents)
                  agents.delete(agentId)
                  return { streamingAgents: agents }
                })
              }
            } else if (event.t === 'done') {
              break
            }
          } catch {
            // skip malformed
          }
        }
      }
    } finally {
      if (started) {
        set({ streaming: false, streamingAgents: new Map() })
        try {
          const chatroom = await api<Chatroom>('GET', `/chatrooms/${targetChatroomId}`)
          set((s) => ({ chatrooms: { ...s.chatrooms, [targetChatroomId]: chatroom } }))
        } catch { /* ignore */ }

        const nextQueued = get().shiftQueuedMessage()
        if (nextQueued) {
          if (get().currentChatroomId !== nextQueued.chatroomId) {
            set((s) => ({ queuedMessages: [nextQueued, ...s.queuedMessages] }))
            return
          }
          set({ pendingFiles: nextQueued.pendingFiles, replyingTo: nextQueued.replyingTo })
          setTimeout(() => {
            void get().sendMessage(nextQueued.text)
          }, 100)
        }
      }
    }
  },

  toggleReaction: async (messageId, emoji) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const previous = get().chatrooms[currentChatroomId]
    if (previous) {
      set((s) => ({
        chatrooms: {
          ...s.chatrooms,
          [currentChatroomId]: {
            ...previous,
            messages: previous.messages.map((message) => {
              if (message.id !== messageId) return message
              const existing = message.reactions.find((reaction) => reaction.emoji === emoji && reaction.reactorId === 'user')
              return {
                ...message,
                reactions: existing
                  ? message.reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.reactorId === 'user'))
                  : [...message.reactions, { emoji, reactorId: 'user', time: Date.now() }],
              }
            }),
          },
        },
      }))
    }
    try {
      const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/reactions`, { messageId, emoji })
      set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
    } catch {
      if (previous) {
        set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: previous } }))
      }
    }
  },

  togglePin: async (messageId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const previous = get().chatrooms[currentChatroomId]
    if (previous) {
      const pinnedMessageIds = previous.pinnedMessageIds || []
      set((s) => ({
        chatrooms: {
          ...s.chatrooms,
          [currentChatroomId]: {
            ...previous,
            pinnedMessageIds: pinnedMessageIds.includes(messageId)
              ? pinnedMessageIds.filter((id) => id !== messageId)
              : [...pinnedMessageIds, messageId],
          },
        },
      }))
    }
    try {
      const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/pins`, { messageId })
      set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
    } catch {
      if (previous) {
        set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: previous } }))
      }
    }
  },

  addMember: async (agentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/members`, { agentId })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  removeMember: async (agentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('DELETE', `/chatrooms/${currentChatroomId}/members`, { agentId })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  setChatroomSheetOpen: (open) => set({ chatroomSheetOpen: open }),
  setEditingChatroomId: (id) => set({ editingChatroomId: id }),

  // Moderation
  deleteMessage: async (messageId, targetAgentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'delete-message',
      targetAgentId,
      messageId,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  muteAgent: async (targetAgentId, minutes = 30) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'mute',
      targetAgentId,
      muteDurationMinutes: minutes,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  unmuteAgent: async (targetAgentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'unmute',
      targetAgentId,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  setMemberRole: async (targetAgentId, role) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'set-role',
      targetAgentId,
      role,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },
}))
