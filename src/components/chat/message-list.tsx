'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '@/types'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { MessageBubble } from './message-bubble'
import { StreamingBubble } from './streaming-bubble'
import { ThinkingIndicator } from './thinking-indicator'

interface Props {
  messages: Message[]
  streaming: boolean
}

export function MessageList({ messages, streaming }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const streamText = useChatStore((s) => s.streamText)
  const session = useAppStore((s) => {
    const id = s.currentSessionId
    return id ? s.sessions[id] : null
  })
  const agents = useAppStore((s) => s.agents)
  const agent = session?.agentId ? agents[session.agentId] : null
  const assistantName = agent?.name
    || (session?.provider === 'claude-cli' ? undefined : session?.model || session?.provider)
    || undefined
  const isHeartbeatMessage = (msg: Message) =>
    msg.role === 'assistant' && (msg.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(msg.text || ''))
  const displayedMessages: Message[] = []
  for (const msg of messages) {
    const isHeartbeat = isHeartbeatMessage(msg)
    const last = displayedMessages[displayedMessages.length - 1]
    const lastIsHeartbeat = !!last && isHeartbeatMessage(last)
    if (isHeartbeat && lastIsHeartbeat) {
      displayedMessages[displayedMessages.length - 1] = msg
    } else {
      displayedMessages.push(msg)
    }
  }

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 150
  }, [])

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setShowScrollToBottom(!isNearBottom(el))
  }, [isNearBottom])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (isNearBottom(el)) {
      el.scrollTop = el.scrollHeight
    }
    updateScrollState()
  }, [messages.length, streamText, isNearBottom, updateScrollState])

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      setShowScrollToBottom(false)
    }
  }, [session?.id])

  const handleScrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollToBottom(false)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => handleScrollToBottom()
    window.addEventListener('agent-ember:scroll-bottom', handler)
    return () => window.removeEventListener('agent-ember:scroll-bottom', handler)
  }, [handleScrollToBottom])

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className="h-full overflow-y-auto px-6 md:px-12 lg:px-16 py-6"
        style={{ scrollBehavior: 'smooth' }}
      >
        <div className="flex flex-col gap-6">
          {displayedMessages.map((msg, i) => (
            <MessageBubble key={`${msg.time}-${i}`} message={msg} assistantName={assistantName} />
          ))}
          {streaming && !streamText && <ThinkingIndicator assistantName={assistantName} />}
          {streaming && streamText && <StreamingBubble text={streamText} assistantName={assistantName} />}
        </div>
      </div>
      {showScrollToBottom && (
        <button
          onClick={handleScrollToBottom}
          className="absolute right-6 md:right-12 lg:right-16 bottom-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-background text-foreground text-[12px] font-600 hover:bg-muted transition-colors shadow-lg cursor-pointer"
          title="Scroll to latest messages"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          Latest
        </button>
      )}
    </div>
  )
}
