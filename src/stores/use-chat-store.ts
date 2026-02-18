'use client'

import { create } from 'zustand'
import type { Message, DevServerStatus, SSEEvent } from '../types'
import { streamChat } from '../lib/chat'
import { speak } from '../lib/tts'
import { useAppStore } from './use-app-store'

interface PendingImage {
  file: File
  path: string
  url: string
}

export interface ToolEvent {
  id: string
  name: string
  input: string
  output?: string
  status: 'running' | 'done'
}

interface ChatState {
  streaming: boolean
  streamText: string

  messages: Message[]
  setMessages: (msgs: Message[]) => void

  toolEvents: ToolEvent[]
  clearToolEvents: () => void

  ttsEnabled: boolean
  toggleTts: () => void

  pendingImage: PendingImage | null
  setPendingImage: (img: PendingImage | null) => void

  devServer: DevServerStatus | null
  setDevServer: (ds: DevServerStatus | null) => void

  debugOpen: boolean
  setDebugOpen: (open: boolean) => void

  sendMessage: (text: string) => Promise<void>
  stopStreaming: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  streaming: false,
  streamText: '',
  messages: [],
  setMessages: (msgs) => set({ messages: msgs, toolEvents: [] }),
  toolEvents: [],
  clearToolEvents: () => set({ toolEvents: [] }),
  ttsEnabled: false,
  toggleTts: () => set((s) => ({ ttsEnabled: !s.ttsEnabled })),
  pendingImage: null,
  setPendingImage: (img) => set({ pendingImage: img }),
  devServer: null,
  setDevServer: (ds) => set({ devServer: ds }),
  debugOpen: false,
  setDebugOpen: (open) => set({ debugOpen: open }),

  sendMessage: async (text: string) => {
    if (!text.trim() || get().streaming) return
    const sessionId = useAppStore.getState().currentSessionId
    if (!sessionId) return

    const { pendingImage } = get()
    const imagePath = pendingImage?.path
    const imageUrl = pendingImage?.url

    const userMsg: Message = {
      role: 'user',
      text,
      time: Date.now(),
      imagePath,
      imageUrl,
    }
    set((s) => ({
      streaming: true,
      streamText: '',
      messages: [...s.messages, userMsg],
      pendingImage: null,
      toolEvents: [],
    }))

    let fullText = ''
    let toolCallCounter = 0

    await streamChat(sessionId, text, imagePath, imageUrl, (event: SSEEvent) => {
      if (event.t === 'd') {
        fullText += event.text || ''
        set({ streamText: fullText })
      } else if (event.t === 'md' || event.t === 'r') {
        fullText = event.text || ''
        set({ streamText: fullText })
      } else if (event.t === 'tool_call') {
        const id = `tc-${++toolCallCounter}`
        set((s) => ({
          toolEvents: [...s.toolEvents, {
            id,
            name: event.toolName || 'unknown',
            input: event.toolInput || '',
            status: 'running',
          }],
        }))
      } else if (event.t === 'tool_result') {
        set((s) => {
          const events = [...s.toolEvents]
          // Find the last running event with matching name
          const idx = events.findLastIndex(
            (e) => e.name === event.toolName && e.status === 'running',
          )
          if (idx !== -1) {
            events[idx] = { ...events[idx], status: 'done', output: event.toolOutput }
          }
          return { toolEvents: events }
        })
      } else if (event.t === 'err') {
        fullText += '\n[Error: ' + (event.text || 'Unknown') + ']'
        set({ streamText: fullText })
      } else if (event.t === 'done') {
        // done
      }
    })

    if (fullText.trim()) {
      const assistantMsg: Message = {
        role: 'assistant',
        text: fullText.trim(),
        time: Date.now(),
      }
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        streaming: false,
        streamText: '',
      }))
      if (get().ttsEnabled) speak(fullText)
    } else {
      set({ streaming: false, streamText: '' })
    }

    useAppStore.getState().loadSessions()
  },

  stopStreaming: async () => {
    const sessionId = useAppStore.getState().currentSessionId
    if (sessionId) {
      try {
        await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
      } catch {
        // ignore
      }
    }
  },
}))
