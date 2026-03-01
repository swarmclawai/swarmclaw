'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { useChatStore } from '@/stores/use-chat-store'
import { fetchMessages, clearMessages, deleteSession, devServer, checkBrowser, stopBrowser } from '@/lib/sessions'
import { uploadImage } from '@/lib/upload'
import { deleteAgent } from '@/lib/agents'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ChatHeader } from './chat-header'
import { DevServerBar } from './dev-server-bar'
import { MessageList } from './message-list'
import { SessionDebugPanel } from './session-debug-panel'
import { VoiceOverlay } from './voice-overlay'
import { useVoiceConversation } from '@/hooks/use-voice-conversation'
import { ChatInput } from '@/components/input/chat-input'
import { ChatPreviewPanel } from './chat-preview-panel'
import { Dropdown, DropdownItem } from '@/components/shared/dropdown'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { speak } from '@/lib/tts'

const PROMPT_SUGGESTIONS = [
  { text: 'What can you help me with?', icon: 'book', gradient: 'from-[#6366F1]/10 to-[#818CF8]/5' },
  { text: 'Help me set up a new connector', icon: 'link', gradient: 'from-[#EC4899]/10 to-[#F472B6]/5' },
  { text: 'Create a new agent for me', icon: 'bot', gradient: 'from-[#34D399]/10 to-[#6EE7B7]/5' },
  { text: 'Schedule a recurring task', icon: 'check', gradient: 'from-[#F59E0B]/10 to-[#FBBF24]/5' },
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
  const appSettings = useAppStore((s) => s.appSettings)
  const { messages, setMessages, streaming, streamingSessionId, sendMessage, stopStreaming, devServer: devServerStatus, setDevServer, debugOpen, setDebugOpen, ttsEnabled, previewContent, setPreviewContent } = useChatStore()
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)

  const voice = useVoiceConversation()
  const handleVoiceToggle = useCallback(() => {
    if (voice.active) voice.stop()
    else voice.start()
  }, [voice])

  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState(false)
  const [browserActive, setBrowserActive] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const setPendingImage = useChatStore((s) => s.setPendingImage)

  useEffect(() => {
    if (!sessionId) return
    const chatState = useChatStore.getState()
    const preserveLocalStream = chatState.streaming && chatState.streamingSessionId === sessionId
    // Clear stale state from the previous session, but keep active local stream state for this session.
    setMessages([])
    if (!preserveLocalStream) {
      useChatStore.setState({ streaming: false, streamingSessionId: null, streamText: '', toolEvents: [] })
    }
    fetchMessages(sessionId).then(setMessages).catch((err) => {
      console.error('Failed to load messages:', err)
      setMessages(session?.messages || [])
    })
    // If server reports session is still active, show streaming state
    if (session?.active) {
      useChatStore.setState({ streaming: true, streamingSessionId: sessionId, streamText: '' })
    }
    // Refresh active state from server so returning to a session restores typing indicator.
    loadSessions().then(() => {
      const refreshed = useAppStore.getState().sessions[sessionId]
      if (refreshed?.active) {
        useChatStore.setState({ streaming: true, streamingSessionId: sessionId, streamText: '' })
      }
    }).catch((err) => console.error('Failed to refresh messages:', err))
    devServer(sessionId, 'status').then((r) => {
      setDevServer(r.running ? r : null)
    }).catch(() => setDevServer(null))
    // Check browser status
    if (session?.tools?.includes('browser')) {
      checkBrowser(sessionId).then((r) => setBrowserActive(r.active)).catch((err) => { console.error('Browser check failed:', err); setBrowserActive(false) })
    } else {
      setBrowserActive(false)
    }
  }, [sessionId])

  // Auto-poll messages for orchestrated or server-active sessions
  const isOrchestrated = session?.sessionType === 'orchestrated'
  const isServerActive = session?.active === true
  const isOngoingMonitored = appSettings.loopMode === 'ongoing' && !!session?.tools?.length
  const shouldPollMessages = !!sessionId && (isOrchestrated || isServerActive || isOngoingMonitored)
  const messagesLenRef = useRef(messages.length)
  messagesLenRef.current = messages.length
  const isServerActiveRef = useRef(isServerActive)
  isServerActiveRef.current = isServerActive
  const ttsEnabledRef = useRef(ttsEnabled)
  ttsEnabledRef.current = ttsEnabled

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return
    try {
      const msgs = await fetchMessages(sessionId)
      if (msgs.length > messagesLenRef.current) {
        const newMsgs = msgs.slice(messagesLenRef.current)
        setMessages(msgs)
        if (ttsEnabledRef.current && typeof document !== 'undefined' && document.visibilityState === 'visible') {
          const latestAssistant = [...newMsgs].reverse().find((m) => {
            if (m.role !== 'assistant') return false
            const isHeartbeat = m.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(m.text || '')
            return !isHeartbeat && !!m.text?.trim()
          })
          if (latestAssistant?.text) {
            void speak(latestAssistant.text)
          }
        }
      }
      if (isServerActiveRef.current) await loadSessions()
    } catch (err) { console.error('Failed to refresh messages:', err) }
  }, [sessionId])

  // Subscribe to WS messages for this session — always subscribe when session exists,
  // only enable fallback polling when actively needed
  useWs(
    sessionId ? `messages:${sessionId}` : '',
    refreshMessages,
    shouldPollMessages ? 2000 : undefined,
  )

  // When server-active flag drops, stop the streaming indicator
  useEffect(() => {
    if (!sessionId) return
    const state = useChatStore.getState()
    if (
      !isServerActive
      && state.streaming
      && (state.streamingSessionId === sessionId || state.streamingSessionId == null)
      && !state.streamText
    ) {
      // Server finished but we weren't the ones streaming — clear the indicator
      fetchMessages(sessionId).then(setMessages).catch(() => {})
      useChatStore.setState({ streaming: false, streamingSessionId: null, streamText: '' })
    }
  }, [isServerActive, sessionId])

  // Poll browser status while session has browser tools
  const hasBrowserTool = session?.tools?.includes('browser')
  const checkBrowserStatus = useCallback(() => {
    if (!sessionId || !hasBrowserTool) return
    checkBrowser(sessionId).then((r) => setBrowserActive(r.active)).catch(() => {})
  }, [sessionId, hasBrowserTool])

  useWs(
    hasBrowserTool && sessionId ? `browser:${sessionId}` : '',
    checkBrowserStatus,
    hasBrowserTool ? 5000 : undefined,
  )

  const handleStopBrowser = useCallback(async () => {
    if (!sessionId) return
    await stopBrowser(sessionId)
    setBrowserActive(false)
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

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragging(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    try {
      const result = await uploadImage(file)
      setPendingImage({ file, path: result.path, url: result.url })
    } catch {
      // ignore
    }
  }, [setPendingImage])

  if (!session) return null

  const streamingForThisSession = streaming && (!streamingSessionId || streamingSessionId === session.id)
  const isMainChat = session.name === '__main__'
  const isEmpty = !messages.length && !streamingForThisSession

  return (
    <div className="flex-1 flex h-full min-h-0 min-w-0">
    <div
      className="flex-1 flex flex-col h-full min-h-0 min-w-0 relative"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDesktop && (
        <ChatHeader
          session={session}
          streaming={streamingForThisSession}
          onStop={stopStreaming}
          onMenuToggle={() => setMenuOpen(!menuOpen)}
          onBack={handleBack}
          browserActive={browserActive}
          onStopBrowser={handleStopBrowser}
          voiceActive={voice.active}
          voiceSupported={voice.supported}
          onVoiceToggle={handleVoiceToggle}
        />
      )}
      {!isDesktop && (
        <ChatHeader
          session={session}
          streaming={streamingForThisSession}
          onStop={stopStreaming}
          onMenuToggle={() => setMenuOpen(!menuOpen)}
          mobile
          browserActive={browserActive}
          onStopBrowser={handleStopBrowser}
          voiceActive={voice.active}
          voiceSupported={voice.supported}
          onVoiceToggle={handleVoiceToggle}
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
        <MessageList messages={messages} streaming={streamingForThisSession} />
      )}

      {voice.active && (
        <VoiceOverlay
          state={voice.state}
          interimText={voice.interimText}
          transcript={voice.transcript}
          onStop={voice.stop}
        />
      )}

      <SessionDebugPanel
        messages={messages}
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
      />

      <ChatInput
        streaming={streamingForThisSession}
        onSend={sendMessage}
        onStop={stopStreaming}
      />

      <Dropdown open={menuOpen} onClose={() => setMenuOpen(false)}>
        {session.agentId && agents[session.agentId] && (
          <DropdownItem onClick={() => { setMenuOpen(false); setEditingAgentId(session.agentId!); setAgentSheetOpen(true) }}>
            Edit Agent
          </DropdownItem>
        )}
        <DropdownItem onClick={() => { setMenuOpen(false); setConfirmClear(true) }}>
          Clear History
        </DropdownItem>
        {session.agentId && agents[session.agentId] && !isMainChat && (
          <DropdownItem danger onClick={() => { setMenuOpen(false); setConfirmDeleteAgent(true) }}>
            Delete Agent
          </DropdownItem>
        )}
        {!isMainChat && (
          <DropdownItem danger onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
            Delete Chat
          </DropdownItem>
        )}
      </Dropdown>

      <ConfirmDialog
        open={confirmClear}
        title="Clear History"
        message="This will delete all messages in this chat. This cannot be undone."
        confirmLabel="Clear"
        danger
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Chat"
        message={`Delete "${session.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
      {session.agentId && agents[session.agentId] && (
        <ConfirmDialog
          open={confirmDeleteAgent}
          title="Delete Agent"
          message={`Delete agent "${agents[session.agentId].name}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            setConfirmDeleteAgent(false)
            await deleteAgent(session.agentId!)
            await loadAgents()
          }}
          onCancel={() => setConfirmDeleteAgent(false)}
        />
      )}

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-none">
          <div className="px-8 py-6 rounded-[20px] border-2 border-dashed border-accent-bright/50 bg-surface/80 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-accent-bright mx-auto mb-3">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="text-[15px] font-600 text-text">Drop file to attach</p>
          </div>
        </div>
      )}
    </div>
    {isDesktop && previewContent && (
      <ChatPreviewPanel content={previewContent} onClose={() => setPreviewContent(null)} />
    )}
    </div>
  )
}

function PromptIcon({ type }: { type: string }) {
  const cls = "w-5 h-5"
  switch (type) {
    case 'book':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#818CF8' }}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
    case 'link':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#F472B6' }}><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
    case 'bot':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#34D399' }}><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" /><circle cx="9" cy="13" r="1.25" fill="currentColor" /><circle cx="15" cy="13" r="1.25" fill="currentColor" /><path d="M10 17h4" /></svg>
    case 'check':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#FBBF24' }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
    default:
      return null
  }
}
