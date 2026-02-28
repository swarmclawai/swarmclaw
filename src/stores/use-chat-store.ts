'use client'

import { create } from 'zustand'
import type { Message, DevServerStatus, SSEEvent } from '../types'
import { streamChat } from '../lib/chat'
import { speak } from '../lib/tts'
import { getStoredAccessKey } from '../lib/api-client'
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
  status: 'running' | 'done' | 'error'
}

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number
}

interface ChatState {
  streaming: boolean
  streamingSessionId: string | null
  streamText: string

  messages: Message[]
  setMessages: (msgs: Message[]) => void

  toolEvents: ToolEvent[]
  clearToolEvents: () => void

  lastUsage: UsageInfo | null

  ttsEnabled: boolean
  toggleTts: () => void

  pendingImage: PendingImage | null
  setPendingImage: (img: PendingImage | null) => void

  devServer: DevServerStatus | null
  setDevServer: (ds: DevServerStatus | null) => void

  debugOpen: boolean
  setDebugOpen: (open: boolean) => void

  sendMessage: (text: string) => Promise<void>
  retryLastMessage: () => Promise<void>
  sendHeartbeat: (sessionId: string) => Promise<void>
  stopStreaming: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  streaming: false,
  streamingSessionId: null,
  streamText: '',
  messages: [],
  setMessages: (msgs) => set({ messages: msgs, toolEvents: [] }),
  toolEvents: [],
  clearToolEvents: () => set({ toolEvents: [] }),
  lastUsage: null,
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
      streamingSessionId: sessionId,
      streamText: '',
      messages: [...s.messages, userMsg],
      pendingImage: null,
      toolEvents: [],
      lastUsage: null,
    }))

    let fullText = ''
    let toolCallCounter = 0
    const shouldIgnoreTransientError = (msg: string) =>
      /cancelled by steer mode|stopped by user/i.test(msg || '')

    await streamChat(sessionId, text, imagePath, imageUrl, (event: SSEEvent) => {
      if (event.t === 'd') {
        fullText += event.text || ''
        set({ streamText: fullText })
      } else if (event.t === 'md') {
        // Parse metadata events (usage/run/queue). Ignore unknown keys.
        try {
          const meta = JSON.parse(event.text || '{}')
          if (meta.usage) {
            set({ lastUsage: meta.usage })
          }
        } catch {
          // Ignore non-JSON metadata payloads.
        }
      } else if (event.t === 'r') {
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
            const output = event.toolOutput || ''
            const isError = /^(Error:|error:|ECONNREFUSED|ETIMEDOUT|timeout|failed)/i.test(output.trim())
              || output.includes('ECONNREFUSED')
              || output.includes('ETIMEDOUT')
              || output.includes('Error:')
            events[idx] = { ...events[idx], status: isError ? 'error' : 'done', output }
          }
          return { toolEvents: events }
        })
      } else if (event.t === 'err') {
        const errText = event.text || 'Unknown'
        if (!shouldIgnoreTransientError(errText)) {
          fullText += '\n[Error: ' + errText + ']'
          set({ streamText: fullText })
        }
      } else if (event.t === 'done') {
        // done
      }
    })

    if (fullText.trim()) {
      const currentToolEvents = get().toolEvents
      const assistantMsg: Message = {
        role: 'assistant',
        text: fullText.trim(),
        time: Date.now(),
        kind: 'chat',
        toolEvents: currentToolEvents.length ? currentToolEvents.map(e => ({
          name: e.name,
          input: e.input,
          output: e.output,
          error: e.status === 'error' || undefined,
        })) : undefined,
      }
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        streaming: false,
        streamingSessionId: null,
        streamText: '',
      }))
      if (get().ttsEnabled) speak(fullText)
    } else {
      set({ streaming: false, streamingSessionId: null, streamText: '' })
    }

    useAppStore.getState().loadSessions()
  },

  retryLastMessage: async () => {
    if (get().streaming) return
    const sessionId = useAppStore.getState().currentSessionId
    if (!sessionId) return
    try {
      const key = getStoredAccessKey()
      const res = await fetch(`/api/sessions/${sessionId}/retry`, {
        method: 'POST',
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (!res.ok) return
      const { message, imagePath } = await res.json()
      if (!message) return
      // Reload messages from server (without the popped ones)
      const msgsRes = await fetch(`/api/sessions/${sessionId}/messages`, {
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (msgsRes.ok) {
        const msgs = await msgsRes.json()
        set({ messages: msgs })
      }
      // Re-send the last user message through the normal SSE flow
      // Temporarily set pendingImage if there was one
      if (imagePath) {
        set({ pendingImage: { file: new File([], ''), path: imagePath, url: '' } })
      }
      await get().sendMessage(message)
    } catch {
      // ignore
    }
  },

  sendHeartbeat: async (sessionId: string) => {
    if (!sessionId || get().streaming) return

    const settings = useAppStore.getState().appSettings
    const heartbeatPrompt = (settings.heartbeatPrompt || '').trim() || 'SWARM_HEARTBEAT_CHECK'

    let fullText = ''
    let sawError = false
    let toolCallCounter = 0
    const heartbeatToolEvents: ToolEvent[] = []

    await streamChat(
      sessionId,
      heartbeatPrompt,
      undefined,
      undefined,
      (event: SSEEvent) => {
        if (event.t === 'd' || event.t === 'r') {
          fullText += event.text || ''
        } else if (event.t === 'md') {
          // metadata only
        } else if (event.t === 'tool_call') {
          heartbeatToolEvents.push({
            id: `hb-tc-${++toolCallCounter}`,
            name: event.toolName || 'unknown',
            input: event.toolInput || '',
            status: 'running',
          })
        } else if (event.t === 'tool_result') {
          const idx = heartbeatToolEvents.findLastIndex(
            (e) => e.name === event.toolName && e.status === 'running',
          )
          if (idx !== -1) {
            const output = event.toolOutput || ''
            const isError = /^(Error:|error:|ECONNREFUSED|ETIMEDOUT|timeout|failed)/i.test(output.trim())
              || output.includes('ECONNREFUSED')
              || output.includes('ETIMEDOUT')
              || output.includes('Error:')
            heartbeatToolEvents[idx] = {
              ...heartbeatToolEvents[idx],
              status: isError ? 'error' : 'done',
              output,
            }
          }
        } else if (event.t === 'err') {
          sawError = true
        }
      },
      { internal: true },
    )

    const trimmed = fullText
      .split('\n')
      .filter((line) => !line.includes('[MAIN_LOOP_META]'))
      .join('\n')
      .trim()
    if (!trimmed || trimmed === 'HEARTBEAT_OK' || sawError) return

    const assistantMsg: Message = {
      role: 'assistant',
      text: trimmed,
      time: Date.now(),
      kind: 'heartbeat',
      toolEvents: heartbeatToolEvents.length
        ? heartbeatToolEvents.map((e) => ({
            name: e.name,
            input: e.input,
            output: e.output,
            error: e.status === 'error' || undefined,
          }))
        : undefined,
    }

    set((s) => ({ messages: [...s.messages, assistantMsg] }))
    useAppStore.getState().loadSessions()
  },

  stopStreaming: async () => {
    const sessionId = useAppStore.getState().currentSessionId
    if (sessionId) {
      try {
        const key = getStoredAccessKey()
        await fetch(`/api/sessions/${sessionId}/stop`, {
          method: 'POST',
          headers: key ? { 'X-Access-Key': key } : undefined,
        })
      } catch {
        // ignore
      }
    }
    set({ streaming: false, streamingSessionId: null, streamText: '' })
  },
}))
