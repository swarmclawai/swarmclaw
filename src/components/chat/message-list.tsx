'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '@/types'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { MessageBubble } from './message-bubble'
import { StreamingBubble } from './streaming-bubble'
import { ThinkingIndicator } from './thinking-indicator'
import { SuggestionsBar } from './suggestions-bar'

function dateSeparator(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

interface Props {
  messages: Message[]
  streaming: boolean
}

export function MessageList({ messages, streaming }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const snapUntilRef = useRef(0)
  const prevSessionIdRef = useRef<string | null>(null)
  const displayText = useChatStore((s) => s.displayText)
  const setMessages = useChatStore((s) => s.setMessages)
  const retryLastMessage = useChatStore((s) => s.retryLastMessage)
  const editAndResend = useChatStore((s) => s.editAndResend)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const forkSession = useAppStore((s) => s.forkSession)
  const session = useAppStore((s) => {
    const id = s.currentSessionId
    return id ? s.sessions[id] : null
  })
  const sessionId = session?.id ?? null
  const agents = useAppStore((s) => s.agents)
  const agent = session?.agentId ? agents[session.agentId] : null
  const appSettings = useAppStore((s) => s.appSettings)
  const assistantName = agent?.name
    || (session?.provider === 'claude-cli' ? undefined : session?.model || session?.provider)
    || undefined

  const showOk = appSettings.heartbeatShowOk ?? false
  const showAlerts = appSettings.heartbeatShowAlerts ?? true

  // Unread count tracking
  const unreadRef = useRef(0)
  const [unreadCount, setUnreadCount] = useState(0)
  const prevMsgCountRef = useRef(messages.length)

  // Bookmark filter
  const [bookmarkFilter, setBookmarkFilter] = useState(false)

  const toggleBookmark = useCallback(async (index: number) => {
    if (!sessionId) return
    const msg = messages[index]
    if (!msg) return
    const next = !msg.bookmarked
    try {
      await api('PUT', `/sessions/${sessionId}/messages`, { messageIndex: index, bookmarked: next })
      const updated = [...messages]
      updated[index] = { ...updated[index], bookmarked: next }
      setMessages(updated)
    } catch (err: unknown) {
      console.error('Failed to toggle bookmark:', err instanceof Error ? err.message : String(err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, messages])

  const handleEditResend = useCallback(async (index: number, newText: string) => {
    if (!sessionId || !editAndResend) return
    await editAndResend(index, newText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleFork = useCallback(async (index: number) => {
    if (!sessionId || !forkSession) return
    await forkSession(sessionId, index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // In-thread search
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const isHeartbeatMessage = (msg: Message) =>
    msg.role === 'assistant' && (msg.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(msg.text || '') || /^\s*NO_MESSAGE\b/i.test(msg.text || ''))
  const isHeartbeatOk = (msg: Message) =>
    msg.suppressed === true || (msg.kind === 'heartbeat' && (/^\s*HEARTBEAT_OK\b/i.test(msg.text || '') || /^\s*NO_MESSAGE\b/i.test(msg.text || '')))

  const displayedMessages: Message[] = []
  for (const msg of messages) {
    const isHeartbeat = isHeartbeatMessage(msg)

    // Visibility filtering based on settings
    if (isHeartbeat) {
      if (!showAlerts) continue // Hide all heartbeat messages
      if (!showOk && isHeartbeatOk(msg)) continue // Hide OK messages
    }

    const last = displayedMessages[displayedMessages.length - 1]
    const lastIsHeartbeat = !!last && isHeartbeatMessage(last)
    if (isHeartbeat && lastIsHeartbeat) {
      displayedMessages[displayedMessages.length - 1] = msg
    } else {
      displayedMessages.push(msg)
    }
  }

  // Apply bookmark filter
  const filteredMessages = bookmarkFilter
    ? displayedMessages.filter((msg) => msg.bookmarked)
    : displayedMessages

  // Search matches
  const searchMatches = searchQuery.trim()
    ? filteredMessages
        .map((msg, i) => ({ msg, i }))
        .filter(({ msg }) => msg.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  // Track whether user is at/near bottom so we know whether to auto-scroll on new content
  const wasAtBottomRef = useRef(true)

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 200
  }, [])

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = isNearBottom(el)
    wasAtBottomRef.current = nearBottom
    setShowScrollToBottom(!nearBottom)
    // Cancel snap window if user manually scrolls away
    if (!nearBottom && Date.now() < snapUntilRef.current) {
      snapUntilRef.current = 0
    }
    if (nearBottom && unreadRef.current > 0) {
      unreadRef.current = 0
      setUnreadCount(0)
    }
  }, [isNearBottom])

  // Track unread messages arriving while scrolled up
  useEffect(() => {
    const newCount = messages.length - prevMsgCountRef.current
    prevMsgCountRef.current = messages.length
    if (newCount > 0 && scrollRef.current && !isNearBottom(scrollRef.current)) {
      unreadRef.current += newCount
      setUnreadCount(unreadRef.current)
    }
  }, [messages.length, isNearBottom])

  // Detect session switch — set snap window and reset scroll state.
  // Must fire before the scroll positioning layoutEffect below.
  useLayoutEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId
      wasAtBottomRef.current = true
      snapUntilRef.current = Date.now() + 2000
    }
  }, [sessionId])

  // Position scroll before paint — no setState here to avoid cascading renders.
  // The onScroll handler and the state-update effect below handle UI state.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || messages.length === 0) return

    const snapping = Date.now() < snapUntilRef.current

    if (snapping || wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
      wasAtBottomRef.current = true
    }
  }, [messages.length, displayText])

  // Update scroll-related UI state after render (separate from layoutEffect to avoid cascading)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || messages.length === 0) return
    updateScrollState()
  }, [messages.length, displayText, updateScrollState])

  // Re-snap when content resizes during snap window (lazy images increasing scrollHeight)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const content = el.firstElementChild as HTMLElement | null
    if (!content) return

    const observer = new ResizeObserver(() => {
      if (Date.now() < snapUntilRef.current || wasAtBottomRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [sessionId])

  const handleScrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollToBottom(false)
    unreadRef.current = 0
    setUnreadCount(0)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => handleScrollToBottom()
    window.addEventListener('swarmclaw:scroll-bottom', handler)
    return () => window.removeEventListener('swarmclaw:scroll-bottom', handler)
  }, [handleScrollToBottom])

  // Ctrl+F search toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen((v) => {
          if (!v) setTimeout(() => searchInputRef.current?.focus(), 50)
          else { setSearchQuery(''); setSearchIdx(0) }
          return !v
        })
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchIdx(0)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [searchOpen])

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      {/* In-thread search bar */}
      {searchOpen && (
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-2 px-6 md:px-12 lg:px-16 py-2 bg-surface/95 backdrop-blur-sm border-b border-white/[0.06]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchIdx(0) }}
            placeholder="Search in conversation..."
            className="flex-1 bg-transparent text-text text-[13px] outline-none placeholder:text-text-3/50"
            style={{ fontFamily: 'inherit' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) setSearchIdx((v) => Math.max(0, v - 1))
                else setSearchIdx((v) => Math.min(searchMatches.length - 1, v + 1))
              }
            }}
          />
          {searchQuery && (
            <span className="text-[11px] text-text-3 tabular-nums shrink-0">
              {searchMatches.length > 0 ? `${searchIdx + 1}/${searchMatches.length}` : '0 results'}
            </span>
          )}
          <button
            onClick={() => setSearchIdx((v) => Math.max(0, v - 1))}
            disabled={!searchMatches.length}
            aria-label="Previous match"
            className="p-1 rounded-[6px] text-text-3 hover:text-text-2 hover:bg-white/[0.04] disabled:opacity-30 cursor-pointer border-none bg-transparent transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m18 15-6-6-6 6" /></svg>
          </button>
          <button
            onClick={() => setSearchIdx((v) => Math.min(searchMatches.length - 1, v + 1))}
            disabled={!searchMatches.length}
            aria-label="Next match"
            className="p-1 rounded-[6px] text-text-3 hover:text-text-2 hover:bg-white/[0.04] disabled:opacity-30 cursor-pointer border-none bg-transparent transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <button
            onClick={() => setBookmarkFilter((v) => !v)}
            aria-label={bookmarkFilter ? 'Show all messages' : 'Show bookmarked only'}
            className={`p-1 rounded-[6px] hover:bg-white/[0.04] cursor-pointer border-none bg-transparent transition-colors ${bookmarkFilter ? 'text-[#F59E0B]' : 'text-text-3 hover:text-text-2'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={bookmarkFilter ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchIdx(0) }}
            aria-label="Close search"
            className="p-1 rounded-[6px] text-text-3 hover:text-text-2 hover:bg-white/[0.04] cursor-pointer border-none bg-transparent transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className="h-full overflow-y-auto px-6 md:px-12 lg:px-16 py-6"
      >
        <div className="flex flex-col gap-6">
          {filteredMessages.map((msg, i) => {
            // Find original index in the full messages array for API calls
            const originalIndex = messages.indexOf(msg)
            const isLastAssistant = msg.role === 'assistant' && !streaming
              && filteredMessages.slice(i + 1).every((m) => m.role !== 'assistant')
            const isSearchMatch = searchQuery && searchMatches.some((m) => m.i === i)
            const isCurrentMatch = searchQuery && searchMatches[searchIdx]?.i === i

            // Date separator
            const prevMsg = i > 0 ? filteredMessages[i - 1] : null
            const showDateSep = msg.time && (!prevMsg?.time || new Date(msg.time).toDateString() !== new Date(prevMsg.time).toDateString())

            return (
              <div key={`${msg.time}-${i}`}>
                {showDateSep && (
                  <div className="flex items-center gap-4 py-2 mb-2">
                    <div className="flex-1 h-px bg-white/[0.06]" />
                    <span className="text-[10px] font-600 text-text-3/50 uppercase tracking-[0.1em]">
                      {dateSeparator(msg.time)}
                    </span>
                    <div className="flex-1 h-px bg-white/[0.06]" />
                  </div>
                )}
                <div className={isCurrentMatch ? 'ring-1 ring-amber-400/50 rounded-[16px] bg-amber-400/[0.04]' : isSearchMatch ? 'bg-white/[0.02] rounded-[16px]' : ''}>
                  <MessageBubble
                    message={msg}
                    assistantName={assistantName}
                    isLast={isLastAssistant}
                    onRetry={isLastAssistant ? retryLastMessage : undefined}
                    messageIndex={originalIndex >= 0 ? originalIndex : undefined}
                    onToggleBookmark={toggleBookmark}
                    onEditResend={handleEditResend}
                    onFork={handleFork}
                  />
                </div>
              </div>
            )
          })}
          {streaming && !displayText && <ThinkingIndicator assistantName={assistantName} />}
          {streaming && displayText && <StreamingBubble text={displayText} assistantName={assistantName} />}
          {!streaming && filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1]?.role === 'assistant' && (
            <SuggestionsBar lastMessage={filteredMessages[filteredMessages.length - 1]} onSend={sendMessage} />
          )}
        </div>
      </div>
      {showScrollToBottom && (
        <button
          onClick={handleScrollToBottom}
          className="absolute right-6 md:right-12 lg:right-16 bottom-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/[0.08] bg-[#171a2b]/95 text-text-2 text-[12px] font-600 hover:bg-[#1e2238] transition-colors shadow-lg cursor-pointer"
          title="Scroll to latest messages"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          Latest
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent-bright text-white text-[10px] font-700">
              {unreadCount}
            </span>
          )}
        </button>
      )}
    </div>
  )
}
