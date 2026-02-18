'use client'

import { useEffect, useRef } from 'react'
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

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length, streamText])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.id])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 md:px-12 lg:px-16 py-6" style={{ scrollBehavior: 'smooth' }}>
      <div className="flex flex-col gap-6">
        {messages.map((msg, i) => (
          <MessageBubble key={`${msg.time}-${i}`} message={msg} assistantName={assistantName} />
        ))}
        {streaming && !streamText && <ThinkingIndicator assistantName={assistantName} />}
        {streaming && streamText && <StreamingBubble text={streamText} assistantName={assistantName} />}
      </div>
    </div>
  )
}
