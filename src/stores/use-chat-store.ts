'use client'

import { create } from 'zustand'
import type { Message, DevServerStatus, SSEEvent } from '../types'
import { streamChat } from '../lib/chat'
import { speak } from '../lib/tts'
import { getStoredAccessKey } from '../lib/api-client'
import { useAppStore } from './use-app-store'
import { getSoundEnabled, setSoundEnabled, playStreamStart, playStreamEnd, playToolComplete, playError } from '../lib/notification-sounds'

export interface PendingFile {
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

  // Task 1: Rich status indicator
  streamPhase: 'thinking' | 'tool' | 'responding'
  streamToolName: string

  // Task 2: Typing cadence simulation
  displayText: string

  // Task 4: Live agent status bar
  agentStatus: { goal?: string; status?: string; summary?: string; nextAction?: string } | null

  messages: Message[]
  setMessages: (msgs: Message[]) => void

  toolEvents: ToolEvent[]
  clearToolEvents: () => void

  lastUsage: UsageInfo | null

  ttsEnabled: boolean
  toggleTts: () => void

  soundEnabled: boolean
  toggleSound: () => void

  // Multi-file attachment support
  pendingFiles: PendingFile[]
  addPendingFile: (f: PendingFile) => void
  removePendingFile: (index: number) => void
  clearPendingFiles: () => void

  // Legacy single-image compat (reads first pendingFile)
  pendingImage: PendingFile | null
  setPendingImage: (img: PendingFile | null) => void

  devServer: DevServerStatus | null
  setDevServer: (ds: DevServerStatus | null) => void

  previewContent: { type: 'browser' | 'image' | 'code' | 'html'; url?: string; content?: string; title?: string } | null
  setPreviewContent: (content: { type: 'browser' | 'image' | 'code' | 'html'; url?: string; content?: string; title?: string } | null) => void

  debugOpen: boolean
  setDebugOpen: (open: boolean) => void

  sendMessage: (text: string) => Promise<void>
  editAndResend: (messageIndex: number, newText: string) => Promise<void>
  retryLastMessage: () => Promise<void>
  sendHeartbeat: (sessionId: string) => Promise<void>
  stopStreaming: () => void

  // Voice conversation
  voiceConversationActive: boolean
  onStreamEvent: ((event: { t: string; text?: string }) => void) | null
}

// Module-level cadence interval (not in state to avoid re-renders)
let _cadenceInterval: ReturnType<typeof setInterval> | null = null
let _cadenceBuffer = ''
let _cadencePos = 0

function clearCadence() {
  if (_cadenceInterval) {
    clearInterval(_cadenceInterval)
    _cadenceInterval = null
  }
  _cadenceBuffer = ''
  _cadencePos = 0
}

const CADENCE_THRESHOLD = 120

export const useChatStore = create<ChatState>((set, get) => ({
  streaming: false,
  streamingSessionId: null,
  streamText: '',
  streamPhase: 'thinking',
  streamToolName: '',
  displayText: '',
  agentStatus: null,
  messages: [],
  setMessages: (msgs) => set({ messages: msgs, toolEvents: [] }),
  toolEvents: [],
  clearToolEvents: () => set({ toolEvents: [] }),
  lastUsage: null,
  ttsEnabled: false,
  toggleTts: () => set((s) => ({ ttsEnabled: !s.ttsEnabled })),
  soundEnabled: getSoundEnabled(),
  toggleSound: () => {
    const next = !get().soundEnabled
    setSoundEnabled(next)
    set({ soundEnabled: next })
  },
  voiceConversationActive: false,
  onStreamEvent: null,

  pendingFiles: [],
  addPendingFile: (f) => set((s) => ({ pendingFiles: [...s.pendingFiles, f] })),
  removePendingFile: (index) => set((s) => ({ pendingFiles: s.pendingFiles.filter((_, i) => i !== index) })),
  clearPendingFiles: () => set({ pendingFiles: [] }),

  // Legacy compat: pendingImage reads/writes the first pending file
  get pendingImage() { const files = get().pendingFiles; return files.length ? files[0] : null },
  setPendingImage: (img) => set({ pendingFiles: img ? [img] : [] }),

  previewContent: null,
  setPreviewContent: (content) => set({ previewContent: content }),

  devServer: null,
  setDevServer: (ds) => set({ devServer: ds }),
  debugOpen: false,
  setDebugOpen: (open) => set({ debugOpen: open }),

  sendMessage: async (text: string) => {
    const { pendingFiles } = get()
    if ((!text.trim() && !pendingFiles.length) || get().streaming) return
    const sessionId = useAppStore.getState().currentSessionId
    if (!sessionId) return

    // Primary image (backward compat)
    const imagePath = pendingFiles[0]?.path
    const imageUrl = pendingFiles[0]?.url
    // All attached file paths
    const attachedFiles = pendingFiles.length > 1
      ? pendingFiles.map((f) => f.path)
      : undefined

    const userMsg: Message = {
      role: 'user',
      text,
      time: Date.now(),
      imagePath,
      imageUrl,
      attachedFiles,
    }
    clearCadence()
    set((s) => ({
      streaming: true,
      streamingSessionId: sessionId,
      streamText: '',
      streamPhase: 'thinking' as const,
      streamToolName: '',
      displayText: '',
      agentStatus: null,
      messages: [...s.messages, userMsg],
      pendingFiles: [],
      toolEvents: [],
      lastUsage: null,
    }))

    // Force scroll to bottom when user sends a message
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('swarmclaw:scroll-bottom'))
    }

    let fullText = ''
    let suggestions: string[] | null = null
    let toolCallCounter = 0
    let soundFiredStart = false
    const shouldIgnoreTransientError = (msg: string) =>
      /cancelled by steer mode|stopped by user/i.test(msg || '')

    await streamChat(sessionId, text, imagePath, imageUrl, (event: SSEEvent) => {
      // Forward events to voice conversation handler if active
      get().onStreamEvent?.(event)
      if (event.t === 'd') {
        fullText += event.text || ''
        set({ streamText: fullText })

        // Phase: first text data → 'responding'
        if (get().streamPhase !== 'responding') {
          set({ streamPhase: 'responding' })
        }

        // Sound: stream start
        if (!soundFiredStart && get().soundEnabled) {
          soundFiredStart = true
          playStreamStart()
        }

        // Typing cadence: buffer first CADENCE_THRESHOLD chars, release word-by-word
        if (fullText.length <= CADENCE_THRESHOLD) {
          _cadenceBuffer = fullText
          if (!_cadenceInterval) {
            _cadenceInterval = setInterval(() => {
              if (_cadencePos >= _cadenceBuffer.length) {
                // Buffer fully released — check if we've passed threshold
                if (get().streamText.length > CADENCE_THRESHOLD) {
                  clearCadence()
                  set({ displayText: get().streamText })
                }
                return
              }
              // Release ~2 chars per 16ms tick
              const nextPos = Math.min(_cadencePos + 2, _cadenceBuffer.length)
              _cadencePos = nextPos
              set({ displayText: _cadenceBuffer.slice(0, _cadencePos) })
            }, 16)
          }
        } else {
          // Past threshold — sync displayText directly
          if (_cadenceInterval) clearCadence()
          set({ displayText: fullText })
        }
      } else if (event.t === 'md') {
        // Parse metadata events (usage/run/queue). Ignore unknown keys.
        try {
          const meta = JSON.parse(event.text || '{}')
          if (meta.usage) {
            set({ lastUsage: meta.usage })
          }
          if (meta.suggestions) {
            suggestions = meta.suggestions
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
          streamPhase: 'tool' as const,
          streamToolName: event.toolName || 'unknown',
          toolEvents: [...s.toolEvents, {
            id,
            name: event.toolName || 'unknown',
            input: event.toolInput || '',
            status: 'running',
          }],
        }))
      } else if (event.t === 'tool_result') {
        const soundOn = get().soundEnabled
        set((s) => {
          const events = [...s.toolEvents]
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
            if (soundOn) {
              if (isError) playError()
              else playToolComplete()
            }
          }
          return { toolEvents: events }
        })
      } else if (event.t === 'err') {
        const errText = event.text || 'Unknown'
        if (!shouldIgnoreTransientError(errText)) {
          fullText += '\n[Error: ' + errText + ']'
          set({ streamText: fullText })
          if (get().soundEnabled) playError()
        }
      } else if (event.t === 'status') {
        try {
          const parsed = JSON.parse(event.text || '{}')
          set({ agentStatus: parsed })
        } catch {
          // ignore malformed status
        }
      } else if (event.t === 'done') {
        // done
      }
    }, attachedFiles)

    clearCadence()
    if (get().soundEnabled && soundFiredStart) playStreamEnd()
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
        suggestions: suggestions || undefined,
      }
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        streaming: false,
        streamingSessionId: null,
        streamText: '',
        displayText: '',
        streamPhase: 'thinking' as const,
        streamToolName: '',
      }))
      if (get().ttsEnabled && !get().voiceConversationActive) speak(fullText)
    } else {
      set({ streaming: false, streamingSessionId: null, streamText: '', displayText: '', streamPhase: 'thinking' as const, streamToolName: '' })
    }

    useAppStore.getState().loadSessions()
  },

  editAndResend: async (messageIndex: number, newText: string) => {
    if (get().streaming) return
    const sessionId = useAppStore.getState().currentSessionId
    if (!sessionId) return
    try {
      const key = getStoredAccessKey()
      const res = await fetch(`/api/sessions/${sessionId}/edit-resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Access-Key': key } : {}),
        },
        body: JSON.stringify({ messageIndex, newText }),
      })
      if (!res.ok) return
      // Reload messages from server (truncated)
      const msgsRes = await fetch(`/api/sessions/${sessionId}/messages`, {
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (msgsRes.ok) {
        const msgs = await msgsRes.json()
        set({ messages: msgs })
      }
      // Re-send with the new text
      await get().sendMessage(newText)
    } catch {
      // ignore
    }
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
      if (imagePath) {
        set({ pendingFiles: [{ file: new File([], ''), path: imagePath, url: '' }] })
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
    if (!trimmed || trimmed === 'HEARTBEAT_OK' || trimmed === 'NO_MESSAGE' || sawError) return

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
    clearCadence()
    set({ streaming: false, streamingSessionId: null, streamText: '', displayText: '', streamPhase: 'thinking' as const, streamToolName: '' })
  },
}))
