'use client'

import { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { fetchMessages, clearMessages, deleteSession, devServer, stopSession } from '@/lib/sessions'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ChatHeader } from './chat-header'
import { DevServerBar } from './dev-server-bar'
import { MessageList } from './message-list'
import { SessionDebugPanel } from './session-debug-panel'
import { ChatInput } from '@/components/input/chat-input'
import { Dropdown, DropdownItem, DropdownSep } from '@/components/shared/dropdown'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

const PROMPT_SUGGESTIONS = [
  { text: 'Help me debug an error in my project', icon: 'bug', gradient: 'from-[#6366F1]/10 to-[#818CF8]/5' },
  { text: 'Generate a new React component', icon: 'code', gradient: 'from-[#EC4899]/10 to-[#F472B6]/5' },
  { text: 'Explain how this codebase works', icon: 'book', gradient: 'from-[#34D399]/10 to-[#6EE7B7]/5' },
  { text: 'Write tests for a function', icon: 'check', gradient: 'from-[#F59E0B]/10 to-[#FBBF24]/5' },
]

export function ChatArea() {
  const session = useAppStore((s) => {
    const id = s.currentSessionId
    return id ? s.sessions[id] : null
  })
  const sessionId = useAppStore((s) => s.currentSessionId)
  const currentUser = useAppStore((s) => s.currentUser)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const removeSessionFromStore = useAppStore((s) => s.removeSession)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const { messages, setMessages, streaming, sendMessage, stopStreaming, devServer: devServerStatus, setDevServer, debugOpen, setDebugOpen } = useChatStore()
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    // Immediately clear stale messages/streaming from the previous session
    setMessages([])
    useChatStore.setState({ streaming: false, streamText: '' })
    fetchMessages(sessionId).then(setMessages).catch(() => {
      setMessages(session?.messages || [])
    })
    devServer(sessionId, 'status').then((r) => {
      setDevServer(r.running ? r : null)
    }).catch(() => setDevServer(null))
  }, [sessionId])

  // Auto-poll messages for orchestrated sessions so user can watch live
  const isOrchestrated = session?.sessionType === 'orchestrated'
  useEffect(() => {
    if (!sessionId || !isOrchestrated) return
    const interval = setInterval(() => {
      fetchMessages(sessionId).then((msgs) => {
        if (msgs.length > messages.length) {
          setMessages(msgs)
        }
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [sessionId, isOrchestrated, messages.length])

  const handleDeploy = useCallback(() => {
    setMenuOpen(false)
    sendMessage('Please git add all changes, commit with a short descriptive message, and push to the remote. Do it now without asking.')
  }, [sendMessage])

  const handleDevServer = useCallback(async () => {
    if (!sessionId) return
    setMenuOpen(false)
    setDevServer({ running: false, url: 'Starting dev server...' })
    try {
      const r = await devServer(sessionId, 'start')
      setDevServer(r.running ? r : null)
    } catch {
      setDevServer(null)
    }
  }, [sessionId])

  const handleStopDevServer = useCallback(async () => {
    if (!sessionId) return
    await devServer(sessionId, 'stop')
    setDevServer(null)
  }, [sessionId])

  const handleClear = useCallback(async () => {
    setConfirmClear(false)
    if (!sessionId) return
    await clearMessages(sessionId)
    setMessages([])
    loadSessions()
  }, [sessionId])

  const handleDelete = useCallback(async () => {
    setConfirmDelete(false)
    if (!sessionId) return
    await deleteSession(sessionId)
    removeSessionFromStore(sessionId)
    setCurrentSession(null)
  }, [sessionId])

  const handleBack = useCallback(() => {
    setCurrentSession(null)
  }, [])

  const handlePrompt = useCallback((text: string) => {
    sendMessage(text)
  }, [sendMessage])

  if (!session) return null

  const isEmpty = !messages.length && !streaming

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 relative">
      {isDesktop && (
        <ChatHeader
          session={session}
          streaming={streaming}
          onStop={stopStreaming}
          onMenuToggle={() => setMenuOpen(!menuOpen)}
          onBack={handleBack}
        />
      )}
      {!isDesktop && (
        <ChatHeader
          session={session}
          streaming={streaming}
          onStop={stopStreaming}
          onMenuToggle={() => setMenuOpen(!menuOpen)}
          mobile
        />
      )}
      <DevServerBar status={devServerStatus} onStop={handleStopDevServer} />

      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-4 relative">
          {/* Atmospheric background glow */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute top-[20%] left-[50%] -translate-x-1/2 w-[500px] h-[300px]"
              style={{
                background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.05) 0%, transparent 70%)',
                animation: 'glow-pulse 6s ease-in-out infinite',
              }} />
          </div>

          <div className="relative max-w-[560px] w-full text-center mb-10"
            style={{ animation: 'fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {/* Sparkle */}
            <div className="flex justify-center mb-5">
              <div className="relative">
                <svg width="32" height="32" viewBox="0 0 48 48" fill="none" className="text-accent-bright"
                  style={{ animation: 'sparkle-spin 8s linear infinite' }}>
                  <path d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
                    fill="currentColor" opacity="0.8" />
                </svg>
                <div className="absolute inset-0 blur-lg bg-accent-bright/20" />
              </div>
            </div>

            <h1 className="font-display text-[28px] md:text-[36px] font-800 leading-[1.1] tracking-[-0.04em] mb-3">
              Hi{currentUser ? ', ' : ' '}<span className="text-accent-bright">{currentUser || 'there'}</span>
              <br />
              <span className="text-text-2">How can I help?</span>
            </h1>
            <p className="text-[13px] text-text-3 mt-2">
              Pick a prompt or type your own below
            </p>
          </div>

          <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 max-w-[640px] w-full mb-6">
            {PROMPT_SUGGESTIONS.map((prompt, i) => (
              <button
                key={prompt.text}
                onClick={() => handlePrompt(prompt.text)}
                className={`suggestion-card p-4 rounded-[14px] border border-white/[0.04] bg-gradient-to-br ${prompt.gradient}
                  text-left cursor-pointer flex flex-col gap-3 min-h-[110px] active:scale-[0.97]`}
                style={{ fontFamily: 'inherit', animation: `fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.07 + 0.15}s both` }}
              >
                <PromptIcon type={prompt.icon} />
                <span className="text-[12px] text-text-2/80 leading-snug flex-1">{prompt.text}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <MessageList messages={messages} streaming={streaming} />
      )}

      <SessionDebugPanel
        messages={messages}
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
      />

      <ChatInput
        streaming={streaming}
        onSend={sendMessage}
        onStop={stopStreaming}
      />

      <Dropdown open={menuOpen} onClose={() => setMenuOpen(false)}>
        <DropdownItem onClick={handleDeploy}>Deploy (commit + push)</DropdownItem>
        <DropdownItem onClick={handleDevServer}>
          {devServerStatus?.running ? 'Dev Server Running' : 'Start Dev Server'}
        </DropdownItem>
        <DropdownSep />
        <DropdownItem onClick={() => { setMenuOpen(false); setConfirmClear(true) }}>
          Clear History
        </DropdownItem>
        <DropdownItem danger onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
          Delete Session
        </DropdownItem>
      </Dropdown>

      <ConfirmDialog
        open={confirmClear}
        title="Clear History"
        message="This will delete all messages in this session. This cannot be undone."
        confirmLabel="Clear"
        danger
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Session"
        message={`Delete "${session.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

function PromptIcon({ type }: { type: string }) {
  const cls = "w-5 h-5"
  switch (type) {
    case 'bug':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#818CF8' }}><path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3 3 0 0 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0 1 12 0v3c0 3.3-2.7 6-6 6zM12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M17.47 9c1.93-.2 3.53-1.9 3.53-4" /></svg>
    case 'code':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#F472B6' }}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
    case 'book':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#34D399' }}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
    case 'check':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#FBBF24' }}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
    default:
      return null
  }
}
