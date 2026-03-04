'use client'

import { create } from 'zustand'
import { api, getStoredAccessKey } from '@/lib/api-client'
import type { Chatroom, ChatroomMessage, ChatroomRoutingRule, SSEEvent } from '@/types'
import type { PendingFile } from '@/stores/use-chat-store'

interface ToolEvent {
  name: string
  input: string
  output?: string
}

interface StreamingAgent {
  text: string
  name: string
  error?: string
  toolEvents: ToolEvent[]
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
    if (!currentChatroomId || streaming || (!text.trim() && !pendingFiles.length)) return

    set({ streaming: true, streamingAgents: new Map(), pendingFiles: [], replyingTo: null })

    const imagePath = pendingFiles.length > 0 && pendingFiles[0].file.type.startsWith('image/')
      ? pendingFiles[0].path
      : undefined
    const attachedFiles = pendingFiles.length > 0
      ? pendingFiles.map((f) => f.path)
      : undefined

    const key = getStoredAccessKey()
    try {
      const res = await fetch(`/api/chatrooms/${currentChatroomId}/chat`, {
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
        set({ streaming: false })
        return
      }

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
              try {
                const { currentChatroomId: cid } = get()
                if (cid) {
                  const chatroom = await api<Chatroom>('GET', `/chatrooms/${cid}`)
                  set((s) => ({ chatrooms: { ...s.chatrooms, [cid]: chatroom } }))
                }
              } catch { /* will catch on next WS push */ }
            } else if (event.t === 'done') {
              break
            }
          } catch {
            // skip malformed
          }
        }
      }
    } finally {
      set({ streaming: false, streamingAgents: new Map() })
      try {
        const { currentChatroomId: cid } = get()
        if (cid) {
          const chatroom = await api<Chatroom>('GET', `/chatrooms/${cid}`)
          set((s) => ({ chatrooms: { ...s.chatrooms, [cid]: chatroom } }))
        }
      } catch { /* ignore */ }
    }
  },

  toggleReaction: async (messageId, emoji) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    await api('POST', `/chatrooms/${currentChatroomId}/reactions`, { messageId, emoji })
    const chatroom = await api<Chatroom>('GET', `/chatrooms/${currentChatroomId}`)
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  togglePin: async (messageId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    await api('POST', `/chatrooms/${currentChatroomId}/pins`, { messageId })
    const chatroom = await api<Chatroom>('GET', `/chatrooms/${currentChatroomId}`)
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
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
