'use client'

import { create } from 'zustand'
import type { Message, DevServerStatus, SSEEvent, ChatTraceBlock } from '../types'
import { streamChat } from '@/lib/chat/chat'
import {
  clearSessionQueue,
  enqueueSessionQueueMessage,
  fetchSessionQueue,
  removeQueuedSessionMessage,
} from '@/lib/chat/chats'
import { mergeCompletedAssistantMessage, reconcileClientMessageMetadata } from '@/lib/chat/chat-streaming-state'
import { createAssistantRenderId } from '@/lib/chat/assistant-render-id'
import { stripAllInternalMetadata } from '@/lib/strip-internal-metadata'
import {
  clearQueuedMessagesForSession,
  createOptimisticQueuedMessage,
  removeQueuedMessageById,
  replaceQueuedMessagesForSession,
  snapshotToQueuedMessages,
  type QueueMessageDraft,
  type QueuedSessionMessage,
} from '@/lib/chat/queued-message-queue'
import { speak } from '../lib/tts'
import { getStoredAccessKey } from '@/lib/app/api-client'
import { useAppStore } from './use-app-store'
import { selectActiveSessionId } from './slices/session-slice'
import { getSoundEnabled, setSoundEnabled, playStreamStart, playStreamEnd, playToolComplete, playError } from '@/lib/notifications/notification-sounds'

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
  streamSource: 'local' | 'server' | null
  streamText: string
  assistantRenderId: string | null

  // Task 1: Rich status indicator
  streamPhase: 'queued' | 'thinking' | 'tool' | 'responding' | 'connecting'
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

  // Reply-to
  replyingTo: { message: Message; index: number } | null
  setReplyingTo: (reply: { message: Message; index: number } | null) => void

  devServer: DevServerStatus | null
  setDevServer: (ds: DevServerStatus | null) => void

  previewContent: { type: 'browser' | 'image' | 'code' | 'html'; url?: string; content?: string; title?: string } | null
  setPreviewContent: (content: { type: 'browser' | 'image' | 'code' | 'html'; url?: string; content?: string; title?: string } | null) => void

  debugOpen: boolean
  setDebugOpen: (open: boolean) => void

  sendMessage: (text: string, options?: { sessionId?: string }) => Promise<void>
  editAndResend: (messageIndex: number, newText: string) => Promise<void>
  retryLastMessage: () => Promise<void>
  sendHeartbeat: (sessionId: string) => Promise<void>
  stopStreaming: () => void

  // Thinking/reasoning text during streaming
  thinkingText: string
  thinkingStartTime: number

  // Rich trace blocks during streaming (F13)
  streamTraces: ChatTraceBlock[]

  // Voice conversation
  voiceConversationActive: boolean
  onStreamEvent: ((event: { t: string; text?: string }) => void) | null

  // Message queue (send while streaming)
  queuedMessages: QueuedSessionMessage[]
  loadQueuedMessages: (sessionId: string) => Promise<void>
  queueMessage: (sessionId: string, draft: QueueMessageDraft) => Promise<void>
  removeQueuedMessage: (sessionId: string, runId: string) => Promise<void>
  clearQueuedMessagesForSession: (sessionId: string) => Promise<void>

  // Context clearing
  clearContext: () => Promise<void>

  // Pagination
  hasMoreMessages: boolean
  loadingMore: boolean
  totalMessages: number
  loadMoreMessages: () => Promise<void>
}

const CONTROL_TOKEN_PREFIX_RE = /^\s*(?:NO_MESSAGE|HEARTBEAT_OK)(?:(?=[\s.,:;!?()[\]{}"'`-]|$)|(?=[A-Z]))\s*/i
const CONTROL_TOKEN_LINE_RE = /(^|\n)\s*(?:NO_MESSAGE|HEARTBEAT_OK)\s*(\n|$)/gi

function stripHiddenControlTokens(text: string): string {
  let cleaned = String(text || '')
  let previous = ''

  while (cleaned !== previous) {
    previous = cleaned
    cleaned = cleaned.replace(CONTROL_TOKEN_PREFIX_RE, '')
  }

  cleaned = cleaned.replace(CONTROL_TOKEN_LINE_RE, '$1')
  cleaned = stripAllInternalMetadata(cleaned)
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

function reconcileMessagesForState(
  nextMessages: Message[],
  currentMessages: Message[],
  assistantRenderId: string | null,
): { messages: Message[]; assistantRenderId: string | null } {
  const messages = reconcileClientMessageMetadata(nextMessages, currentMessages)
  const nextAssistantRenderId = assistantRenderId && messages.some((message) => message.clientRenderId === assistantRenderId)
    ? assistantRenderId
    : null
  return { messages, assistantRenderId: nextAssistantRenderId }
}

function syncSessionQueueState(sessionId: string, params: {
  queuedCount: number
  currentRunId?: string | null
  active?: boolean
}): void {
  const appState = useAppStore.getState()
  const session = appState.sessions[sessionId]
  if (!session) return
  appState.updateSessionInStore({
    ...session,
    queuedCount: params.queuedCount,
    currentRunId: params.currentRunId ?? null,
    active: params.active ?? session.active,
  })
}

function markSessionRunIdle(sessionId: string): void {
  const appState = useAppStore.getState()
  const session = appState.sessions[sessionId]
  if (!session) return
  appState.updateSessionInStore({
    ...session,
    active: false,
    currentRunId: null,
  })
}

export const useChatStore = create<ChatState>((set, get) => ({
  streaming: false,
  streamingSessionId: null,
  streamSource: null,
  streamText: '',
  assistantRenderId: null,
  streamPhase: 'thinking',
  streamToolName: '',
  displayText: '',
  agentStatus: null,
  messages: [],
  setMessages: (msgs) => set((s) => {
    const next = reconcileMessagesForState(msgs, s.messages, s.assistantRenderId)
    // Clear "sending" queue items whose text now appears in the message list
    const queuedMessages = s.queuedMessages.filter((item) => {
      if (!item.sending) return true
      if (next.messages.some((m) => m.role === 'user' && m.text === item.text)) return false
      if (Date.now() - item.queuedAt > 15_000) return false
      return true
    })
    const patch: Partial<ChatState> = {
      messages: next.messages,
      assistantRenderId: next.assistantRenderId,
      queuedMessages,
    }
    if (s.toolEvents.length > 0) patch.toolEvents = []
    if (s.hasMoreMessages) patch.hasMoreMessages = false
    if (s.totalMessages !== next.messages.length) patch.totalMessages = next.messages.length
    return patch
  }),
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
  thinkingText: '',
  thinkingStartTime: 0,
  streamTraces: [],
  voiceConversationActive: false,
  onStreamEvent: null,
  queuedMessages: [],
  loadQueuedMessages: async (sessionId) => {
    if (!sessionId) return
    const snapshot = await fetchSessionQueue(sessionId)
    set((s) => {
      const next = replaceQueuedMessagesForSession(
        s.queuedMessages,
        sessionId,
        snapshotToQueuedMessages(snapshot),
        { activeRunId: snapshot.activeRunId },
      )
      // Clear "sending" items whose text has already appeared in chat messages
      const messages = s.messages
      const cleaned = next.filter((item) => {
        if (!item.sending || item.sessionId !== sessionId) return true
        if (messages.some((m) => m.role === 'user' && m.text === item.text)) return false
        if (Date.now() - item.queuedAt > 15_000) return false
        return true
      })
      return { queuedMessages: cleaned }
    })
    syncSessionQueueState(sessionId, {
      queuedCount: snapshot.queueLength,
      currentRunId: snapshot.activeRunId,
      active: snapshot.activeRunId ? true : useAppStore.getState().sessions[sessionId]?.active,
    })
  },
  queueMessage: async (sessionId, draft) => {
    if (!sessionId) return
    const existingForSession = get().queuedMessages.filter((item) => item.sessionId === sessionId).length
    const optimistic = createOptimisticQueuedMessage(sessionId, draft, existingForSession + 1)
    set((s) => ({
      queuedMessages: [...s.queuedMessages, optimistic],
    }))
    syncSessionQueueState(sessionId, {
      queuedCount: Math.max(
        useAppStore.getState().sessions[sessionId]?.queuedCount ?? 0,
        existingForSession + 1,
      ),
      currentRunId: useAppStore.getState().sessions[sessionId]?.currentRunId ?? null,
      active: true,
    })

    try {
      const response = await enqueueSessionQueueMessage(sessionId, {
        message: draft.text,
        imagePath: draft.imagePath,
        imageUrl: draft.imageUrl,
        attachedFiles: draft.attachedFiles,
        replyToId: draft.replyToId,
      })
      set((s) => ({
        queuedMessages: replaceQueuedMessagesForSession(
          removeQueuedMessageById(s.queuedMessages, optimistic.runId),
          sessionId,
          snapshotToQueuedMessages(response.snapshot),
          { activeRunId: response.snapshot.activeRunId },
        ),
      }))
      syncSessionQueueState(sessionId, {
        queuedCount: response.snapshot.queueLength,
        currentRunId: response.snapshot.activeRunId,
        active: true,
      })
    } catch (error) {
      set((s) => ({
        queuedMessages: removeQueuedMessageById(s.queuedMessages, optimistic.runId),
      }))
      const session = useAppStore.getState().sessions[sessionId]
      syncSessionQueueState(sessionId, {
        queuedCount: Math.max(0, (session?.queuedCount ?? 1) - 1),
        currentRunId: session?.currentRunId ?? null,
        active: session?.active,
      })
      throw error
    }
  },
  removeQueuedMessage: async (sessionId, runId) => {
    if (!sessionId || !runId) return
    set((s) => ({ queuedMessages: removeQueuedMessageById(s.queuedMessages, runId) }))
    const response = await removeQueuedSessionMessage(sessionId, runId)
    set((s) => ({
      queuedMessages: replaceQueuedMessagesForSession(
        s.queuedMessages,
        sessionId,
        snapshotToQueuedMessages(response.snapshot),
        { activeRunId: response.snapshot.activeRunId },
      ),
    }))
    syncSessionQueueState(sessionId, {
      queuedCount: response.snapshot.queueLength,
      currentRunId: response.snapshot.activeRunId,
      active: useAppStore.getState().sessions[sessionId]?.active,
    })
  },
  clearQueuedMessagesForSession: async (sessionId) => {
    if (!sessionId) return
    set((s) => ({ queuedMessages: clearQueuedMessagesForSession(s.queuedMessages, sessionId) }))
    const response = await clearSessionQueue(sessionId)
    set((s) => ({
      queuedMessages: replaceQueuedMessagesForSession(
        s.queuedMessages,
        sessionId,
        snapshotToQueuedMessages(response.snapshot),
        { activeRunId: response.snapshot.activeRunId },
      ),
    }))
    syncSessionQueueState(sessionId, {
      queuedCount: response.snapshot.queueLength,
      currentRunId: response.snapshot.activeRunId,
      active: useAppStore.getState().sessions[sessionId]?.active,
    })
  },

  pendingFiles: [],
  addPendingFile: (f) => set((s) => ({ pendingFiles: [...s.pendingFiles, f] })),
  removePendingFile: (index) => set((s) => ({ pendingFiles: s.pendingFiles.filter((_, i) => i !== index) })),
  clearPendingFiles: () => set({ pendingFiles: [] }),

  // Legacy compat: pendingImage reads/writes the first pending file
  get pendingImage() { const files = get().pendingFiles; return files.length ? files[0] : null },
  setPendingImage: (img) => set({ pendingFiles: img ? [img] : [] }),

  // Reply-to
  replyingTo: null,
  setReplyingTo: (reply) => set({ replyingTo: reply }),

  previewContent: null,
  setPreviewContent: (content) => set({ previewContent: content }),

  devServer: null,
  setDevServer: (ds) => set({ devServer: ds }),
  debugOpen: false,
  setDebugOpen: (open) => set({ debugOpen: open }),

  sendMessage: async (text: string, options) => {
    const targetSessionId = options?.sessionId || selectActiveSessionId(useAppStore.getState())
    const { pendingFiles, replyingTo } = get()
    const filesForSend = pendingFiles
    const replyForSend = replyingTo
    if ((!text.trim() && !filesForSend.length) || get().streaming) return
    const sessionId = targetSessionId
    if (!sessionId) return

    // Primary image (backward compat)
    const imagePath = filesForSend[0]?.path
    const imageUrl = filesForSend[0]?.url
    // All attached file paths
    const attachedFiles = filesForSend.length > 1
      ? filesForSend.map((f) => f.path)
      : undefined
    const replyToId = replyForSend?.message?.replyToId ? undefined : replyForSend?.message ? `msg-${replyForSend.index}` : undefined

    const userMsg: Message = {
      role: 'user',
      text,
      time: Date.now(),
      imagePath,
      imageUrl,
      attachedFiles,
      ...(replyToId ? { replyToId } : {}),
    }
    const assistantRenderId = createAssistantRenderId()
    set((s) => ({
      streaming: true,
      streamingSessionId: sessionId,
      streamSource: 'local' as const,
      streamText: '',
      assistantRenderId,
      streamPhase: 'queued' as const,
      streamToolName: '',
      displayText: '',
      agentStatus: null,
      thinkingText: '',
      thinkingStartTime: Date.now(),
      messages: [...s.messages, userMsg],
      pendingFiles: [],
      replyingTo: null,
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
      /cancelled by steer mode|stopped by user|stream timed out/i.test(msg || '')

    try { await streamChat(sessionId, text, imagePath, imageUrl, (event: SSEEvent) => {
      // Forward events to voice conversation handler if active
      get().onStreamEvent?.(event)
      if (event.t === 'd') {
        fullText += event.text || ''
        const visibleText = stripHiddenControlTokens(fullText)

        // Sound: stream start
        if (!soundFiredStart && get().soundEnabled) {
          soundFiredStart = true
          playStreamStart()
        }

        // Build a single patch for all state changes this event
        const patch: Partial<ChatState> = { streamText: visibleText, displayText: visibleText }

        // Phase: first text data → 'responding'
        if (get().streamPhase !== 'responding') {
          patch.streamPhase = 'responding'
        }

        set(patch)
      } else if (event.t === 'md') {
        // Parse metadata events (usage/run/queue/thinking). Ignore unknown keys.
        try {
          const meta = JSON.parse(event.text || '{}')
          const mdPatch: Partial<ChatState> = {}
          if (meta.usage) {
            mdPatch.lastUsage = meta.usage
          }
          if (meta.suggestions) {
            suggestions = meta.suggestions
          }
          if (meta.thinking && typeof meta.thinking === 'string') {
            mdPatch.thinkingText = meta.thinking
          }
          if (meta.run?.status === 'queued') {
            mdPatch.streamPhase = 'queued'
          } else if (meta.run?.status === 'running') {
            const current = get().streamPhase
            if (current === 'queued' || current === 'connecting') {
              mdPatch.streamPhase = 'thinking'
            }
          }
          if (Object.keys(mdPatch).length > 0) {
            set(mdPatch)
          }
        } catch {
          // Ignore non-JSON metadata payloads.
        }
      } else if (event.t === 'r') {
        fullText = event.text || ''
        const visibleText = stripHiddenControlTokens(fullText)
        set({ streamText: visibleText, displayText: visibleText })
      } else if (event.t === 'tool_call') {
        // Dedup: skip if the last tool event matches name+input and is still running
        const currentEvents = get().toolEvents
        const lastEvent = currentEvents[currentEvents.length - 1]
        if (
          lastEvent
          && lastEvent.name === (event.toolName || 'unknown')
          && lastEvent.input === (event.toolInput || '')
          && lastEvent.status === 'running'
        ) {
          // Duplicate — skip without triggering subscribers
        } else {
          const id = `tc-${++toolCallCounter}`
          set({
            streamPhase: 'tool' as const,
            streamToolName: event.toolName || 'unknown',
            toolEvents: [...currentEvents, {
              id,
              name: event.toolName || 'unknown',
              input: event.toolInput || '',
              status: 'running',
            }],
          })
        }
      } else if (event.t === 'tool_result') {
        const soundOn = get().soundEnabled
        const currentEvents = get().toolEvents
        const idx = currentEvents.findLastIndex(
          (e) => e.name === event.toolName && e.status === 'running',
        )
        if (idx === -1) {
          // No running event found — check if last event already matches (dedup)
          const last = currentEvents[currentEvents.length - 1]
          const output = event.toolOutput || ''
          const isError = /^(Error:|error:|ECONNREFUSED|ETIMEDOUT|timeout|failed)/i.test(output.trim())
            || output.includes('ECONNREFUSED')
            || output.includes('ETIMEDOUT')
            || output.includes('Error:')
          if (
            last
            && last.name === event.toolName
            && last.output === output
            && last.status === (isError ? 'error' : 'done')
          ) {
            // Already matches — skip without triggering subscribers
          }
        } else {
          const events = [...currentEvents]
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
          set({ toolEvents: events })
        }
      } else if (event.t === 'reset') {
        // Server rolled back state after a transient error — clear accumulated
        // text and tool events so the retry starts with a clean slate.
        fullText = event.text || ''
        const visibleText = stripHiddenControlTokens(fullText)
        toolCallCounter = 0
        soundFiredStart = false
        set({ streamText: visibleText, displayText: visibleText, toolEvents: [], streamPhase: 'connecting' })
      } else if (event.t === 'err') {
        const errText = event.text || 'Unknown'
        if (!shouldIgnoreTransientError(errText)) {
          fullText += '\n[Error: ' + errText + ']'
          const visibleText = stripHiddenControlTokens(fullText)
          set({ streamText: visibleText, displayText: visibleText })
          if (get().soundEnabled) playError()
        }
      } else if (event.t === 'thinking') {
        set((s) => ({ thinkingText: s.thinkingText + (event.text || '') }))
      } else if (event.t === 'status') {
        try {
          const parsed = JSON.parse(event.text || '{}')
          if (
            parsed
            && typeof parsed === 'object'
            && ['goal', 'status', 'summary', 'nextAction'].some((key) => key in parsed)
          ) {
            set({ agentStatus: parsed })
          }
        } catch {
          // ignore malformed status
        }
      } else if (event.t === 'done') {
        // done
      }
    }, attachedFiles, { replyToId })

    if (get().soundEnabled && soundFiredStart) playStreamEnd()
    const visibleFinalText = stripHiddenControlTokens(fullText)
    if (visibleFinalText.trim()) {
      const currentToolEvents = get().toolEvents
      const thinkingSnapshot = get().thinkingText || undefined
      const activeAssistantRenderId = get().assistantRenderId || undefined
      const assistantMsg: Message = {
        role: 'assistant',
        text: visibleFinalText.trim(),
        time: Date.now(),
        clientRenderId: activeAssistantRenderId,
        kind: 'chat',
        thinking: thinkingSnapshot,
        toolEvents: currentToolEvents.length ? currentToolEvents.map(e => ({
          name: e.name,
          input: e.input,
          output: e.output,
          error: e.status === 'error' || undefined,
        })) : undefined,
        suggestions: suggestions || undefined,
      }
      set((s) => ({
        messages: mergeCompletedAssistantMessage(s.messages, assistantMsg),
        streaming: false,
        streamingSessionId: null,
        streamSource: null,
        streamText: '',
        displayText: '',
        streamPhase: 'thinking' as const,
        streamToolName: '',
        thinkingText: '',
        thinkingStartTime: 0,
      }))
      markSessionRunIdle(sessionId)
      if (get().ttsEnabled && !get().voiceConversationActive) speak(visibleFinalText)
    } else {
      set({
        streaming: false,
        streamingSessionId: null,
        streamSource: null,
        streamText: '',
        assistantRenderId: null,
        displayText: '',
        streamPhase: 'thinking' as const,
        streamToolName: '',
        thinkingText: '',
        thinkingStartTime: 0,
      })
      markSessionRunIdle(sessionId)
    }

    void useAppStore.getState().refreshSession(sessionId)

    } finally {
      if (get().streaming) {
        set({
          streaming: false,
          streamingSessionId: null,
          streamSource: null,
          streamText: '',
          assistantRenderId: null,
          displayText: '',
          streamPhase: 'thinking' as const,
          streamToolName: '',
          thinkingText: '',
          thinkingStartTime: 0,
        })
        markSessionRunIdle(sessionId)
      }
    }
  },

  editAndResend: async (messageIndex: number, newText: string) => {
    if (get().streaming) return
    const sessionId = selectActiveSessionId(useAppStore.getState())
    if (!sessionId) return
    try {
      const key = getStoredAccessKey()
      const res = await fetch(`/api/chats/${sessionId}/edit-resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Access-Key': key } : {}),
        },
        body: JSON.stringify({ messageIndex, newText }),
      })
      if (!res.ok) return
      // Reload messages from server (truncated)
      const msgsRes = await fetch(`/api/chats/${sessionId}/messages`, {
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (msgsRes.ok) {
        const msgs = await msgsRes.json()
        get().setMessages(msgs)
      }
      // Re-send with the new text
      await get().sendMessage(newText)
    } catch {
      // ignore
    }
  },

  retryLastMessage: async () => {
    if (get().streaming) return
    const sessionId = selectActiveSessionId(useAppStore.getState())
    if (!sessionId) return
    try {
      const key = getStoredAccessKey()
      const res = await fetch(`/api/chats/${sessionId}/retry`, {
        method: 'POST',
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (!res.ok) return
      const { message, imagePath } = await res.json()
      if (!message) return
      // Reload messages from server (without the popped ones)
      const msgsRes = await fetch(`/api/chats/${sessionId}/messages`, {
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (msgsRes.ok) {
        const msgs = await msgsRes.json()
        get().setMessages(msgs)
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
        } else if (event.t === 'reset') {
          fullText = event.text || ''
          heartbeatToolEvents.length = 0
          toolCallCounter = 0
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
    void useAppStore.getState().refreshSession(sessionId)
  },

  clearContext: async () => {
    const sessionId = selectActiveSessionId(useAppStore.getState())
    if (!sessionId || get().streaming) return
    const marker: Message = { role: 'user', text: '', kind: 'context-clear', time: Date.now() }
    set((s) => ({ messages: [...s.messages, marker] }))
    try {
      const key = getStoredAccessKey()
      await fetch(`/api/chats/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Access-Key': key } : {}) },
        body: JSON.stringify({ kind: 'context-clear' }),
      })
    } catch {
      // Ignore — marker is already in local state
    }
  },

  hasMoreMessages: false,
  loadingMore: false,
  totalMessages: 0,
  loadMoreMessages: async () => {
    const { messages, loadingMore, hasMoreMessages, totalMessages } = get()
    if (loadingMore || !hasMoreMessages) return
    const sessionId = selectActiveSessionId(useAppStore.getState())
    if (!sessionId) return
    set({ loadingMore: true })
    try {
      const key = getStoredAccessKey()
      // Find the earliest message's original index (startIndex tracked on initial load)
      const currentStartIndex = totalMessages - messages.length
      const res = await fetch(`/api/chats/${sessionId}/messages?limit=100&before=${currentStartIndex}`, {
        headers: key ? { 'X-Access-Key': key } : undefined,
      })
      if (res.ok) {
        const data = await res.json() as { messages: Message[]; total: number; hasMore: boolean; startIndex: number }
        set((s) => {
          const next = reconcileMessagesForState(
            [...data.messages, ...s.messages],
            s.messages,
            s.assistantRenderId,
          )
          return {
            messages: next.messages,
            assistantRenderId: next.assistantRenderId,
            hasMoreMessages: data.hasMore,
            totalMessages: data.total,
            loadingMore: false,
          }
        })
      } else {
        set({ loadingMore: false })
      }
    } catch {
      set({ loadingMore: false })
    }
  },

  stopStreaming: async () => {
    const sessionId = selectActiveSessionId(useAppStore.getState())
    if (sessionId) {
      try {
        const key = getStoredAccessKey()
        await fetch(`/api/chats/${sessionId}/stop`, {
          method: 'POST',
          headers: key ? { 'X-Access-Key': key } : undefined,
        })
      } catch {
        // ignore
      }
    }
    set({
      streaming: false,
      streamingSessionId: null,
      streamSource: null,
      streamText: '',
      assistantRenderId: null,
      displayText: '',
      streamPhase: 'thinking' as const,
      streamToolName: '',
      thinkingText: '',
      thinkingStartTime: 0,
      toolEvents: [],
      agentStatus: null,
    })
    if (sessionId) markSessionRunIdle(sessionId)
  },
}))
