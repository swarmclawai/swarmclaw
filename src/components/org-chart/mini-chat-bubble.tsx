'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/app/api-client'
import { fetchMessages } from '@/lib/chat/chats'
import { streamChat } from '@/lib/chat/chat'
import type { Agent, Message, Session, SSEEvent } from '@/types'
import { INTERNAL_KEY_RE, stripAllInternalMetadata } from '@/lib/strip-internal-metadata'

interface Props {
  agent: Agent
  onClose: () => void
  onToolActivity?: (toolName: string) => void
}

const BUBBLE_W = 320

/** Client-side cache: agentId → sessionId, avoids redundant POST on reopen */
const sessionCache = new Map<string, string>()

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Filter status text that looks like raw IDs or data dumps */
function sanitizeToolStatus(text: string): string | null {
  if (!text) return null
  // Skip raw arrays or objects
  if (text.startsWith('[') || text.startsWith('{')) return null
  // Skip if it looks like it's mostly UUIDs
  if (UUID_RE.test(text)) return null
  // Truncate to reasonable length
  return text.slice(0, 60)
}

export function MiniChatBubble({ agent, onClose, onToolActivity }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelledRef = useRef(false)

  // Initialize: get or create thread session, load messages
  const init = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const cachedSid = sessionCache.get(agent.id)
      if (cachedSid) {
        // Try cached session first — skip POST entirely
        try {
          const msgs = await fetchMessages(cachedSid)
          if (cancelledRef.current) return
          setSessionId(cachedSid)
          setMessages(msgs)
          return
        } catch {
          // Cached session gone — clear and fall through to POST
          sessionCache.delete(agent.id)
        }
      }

      const session = await api<Session>('POST', `/agents/${agent.id}/thread`)
      if (cancelledRef.current) return
      setSessionId(session.id)
      sessionCache.set(agent.id, session.id)

      // Use messages from POST response if present, otherwise fetch
      if (Array.isArray(session.messages) && session.messages.length > 0) {
        setMessages(session.messages as Message[])
      } else {
        const msgs = await fetchMessages(session.id)
        if (cancelledRef.current) return
        setMessages(msgs)
      }
    } catch {
      if (!cancelledRef.current) setError('Could not connect to agent')
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [agent.id])

  useEffect(() => {
    cancelledRef.current = false
    init()
    return () => { cancelledRef.current = true }
  }, [init])

  // Real-time message refresh via WebSocket (mirrors main ChatArea pattern)
  const refreshMessages = useCallback(async () => {
    if (!sessionId || streaming) return
    try {
      const msgs = await fetchMessages(sessionId)
      setMessages(msgs)
    } catch { /* ignore */ }
  }, [sessionId, streaming])

  useWs(
    sessionId ? `messages:${sessionId}` : '',
    refreshMessages,
    streaming ? 2000 : undefined,
  )

  // Auto-scroll to bottom on new messages or streaming text
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamText])

  // Focus input once loaded
  useEffect(() => {
    if (!loading && inputRef.current) inputRef.current.focus()
  }, [loading])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const send = useCallback(async () => {
    if (!sessionId || !inputValue.trim() || streaming) return
    const text = inputValue.trim()
    setInputValue('')

    // Optimistic user message
    const userMsg: Message = { role: 'user', text, time: Date.now() }
    setMessages((prev) => [...prev, userMsg])
    setStreaming(true)
    setStreamText('')

    await streamChat(sessionId, text, undefined, undefined, (event: SSEEvent) => {
      switch (event.t) {
        case 'd':
          if (event.text) setStreamText((prev) => prev + event.text)
          break
        case 'md':
          // Skip run-status metadata (JSON blobs from the queue system)
          if (event.text && !event.text.startsWith('{') && !INTERNAL_KEY_RE.test(event.text)) {
            setStreamText((prev) => prev + event.text)
          }
          break
        case 'tool_call':
          if (event.toolName) onToolActivity?.(event.toolName)
          break
        case 'status': {
          const cleaned = event.text ? sanitizeToolStatus(event.text) : null
          if (cleaned) onToolActivity?.(cleaned)
          break
        }
        case 'done':
          // Refresh messages to get the final state
          if (sessionId) fetchMessages(sessionId).then((msgs) => setMessages(msgs)).catch(() => {})
          setStreaming(false)
          setStreamText('')
          break
        case 'err':
          if (sessionId) fetchMessages(sessionId).then((msgs) => setMessages(msgs)).catch(() => {})
          setStreaming(false)
          setStreamText('')
          break
      }
    })
  }, [sessionId, inputValue, streaming, onToolActivity])

  const stop = useCallback(() => {
    if (sessionId) {
      api('POST', `/chats/${sessionId}/stop`).catch(() => {})
    }
    setStreaming(false)
    setStreamText('')
  }, [sessionId])

  // Filter out system/heartbeat messages
  const visibleMessages = messages.filter(
    (m) => !m.suppressed && m.kind !== 'heartbeat' && m.kind !== 'context-clear',
  )

  return (
    <div
      className="flex flex-col rounded-[12px] border border-white/[0.08] bg-[#12121e] shadow-2xl shadow-black/50 overflow-hidden"
      style={{ width: BUBBLE_W, height: 400 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] bg-white/[0.02] shrink-0">
        <AgentAvatar
          seed={agent.avatarSeed || null}
          avatarUrl={agent.avatarUrl}
          name={agent.name}
          size={20}
        />
        <span className="text-[12px] font-600 text-text truncate flex-1">{agent.name}</span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-[4px] flex items-center justify-center text-text-3 hover:text-text hover:bg-white/[0.08] cursor-pointer border-none transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1 1l8 8M9 1l-8 8" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0">
        {loading && (
          <div className="text-[11px] text-text-3/50 text-center py-8">Loading...</div>
        )}
        {!loading && error && (
          <div className="text-center py-8 space-y-2">
            <div className="text-[11px] text-red-400/70">{error}</div>
            <button
              onClick={() => { init() }}
              className="text-[11px] text-accent-bright/70 hover:text-accent-bright cursor-pointer border-none bg-transparent underline"
            >
              Retry
            </button>
          </div>
        )}
        {!loading && !error && visibleMessages.length === 0 && !streaming && (
          <div className="text-[11px] text-text-3/40 text-center py-8">
            Start a conversation with {agent.name}
          </div>
        )}
        {visibleMessages.map((msg, i) => (
          <MessageRow key={`${msg.time}-${i}`} message={msg} />
        ))}
        {streaming && streamText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-[8px] px-2.5 py-1.5 bg-white/[0.04] border border-white/[0.06]">
              <div className="mini-chat-md text-[12px] text-text-2 leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripAllInternalMetadata(streamText)}</ReactMarkdown>
              </div>
              <span className="inline-block w-[5px] h-[12px] bg-accent-bright/60 ml-0.5 animate-pulse" />
            </div>
          </div>
        )}
        {streaming && !streamText && (
          <div className="flex justify-start">
            <div className="rounded-[8px] px-2.5 py-1.5 bg-white/[0.04] border border-white/[0.06]">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-text-3/40 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-text-3/40 animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-text-3/40 animate-pulse" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex items-center gap-1.5 px-2 py-2 border-t border-white/[0.06] shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Type a message..."
          disabled={loading || !!error || !sessionId}
          className="flex-1 text-[12px] bg-white/[0.04] border border-white/[0.06] rounded-[6px] px-2.5 py-1.5 text-text placeholder:text-text-3/30 outline-none focus:border-accent-bright/30 transition-colors disabled:opacity-40"
        />
        {streaming ? (
          <button
            onClick={stop}
            className="w-7 h-7 rounded-[6px] flex items-center justify-center bg-red-500/20 text-red-400 hover:bg-red-500/30 cursor-pointer border-none transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect x="1" y="1" width="8" height="8" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!inputValue.trim() || loading || !sessionId}
            className="w-7 h-7 rounded-[6px] flex items-center justify-center bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 cursor-pointer border-none transition-colors disabled:opacity-30 disabled:cursor-default"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M1 11L11 6L1 1v4l5 1-5 1z" />
            </svg>
          </button>
        )}
      </div>

      {/* Caret pointing down */}
      <div
        className="absolute left-1/2 -translate-x-1/2 w-0 h-0"
        style={{
          bottom: -8,
          borderLeft: '8px solid transparent',
          borderRight: '8px solid transparent',
          borderTop: '8px solid #12121e',
        }}
      />
    </div>
  )
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-[8px] px-2.5 py-1.5 ${
          isUser
            ? 'bg-accent-bright/15 border border-accent-bright/20'
            : 'bg-white/[0.04] border border-white/[0.06]'
        }`}
      >
        {isUser ? (
          <p className="text-[12px] text-text leading-relaxed whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <div className="mini-chat-md text-[12px] text-text-2 leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripAllInternalMetadata(message.text)}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
