'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useNow } from '@/hooks/use-now'
import { fetchMessages } from '@/lib/chats'
import { api } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import type { Agent, Session } from '@/types'
import { AgentAvatar } from './agent-avatar'
import { toast } from 'sonner'

interface Props {
  inSidebar?: boolean
  onSelect?: () => void
}

export function AgentChatList({ inSidebar, onSelect }: Props) {
  const now = useNow()
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const setMessages = useChatStore((s) => s.setMessages)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const tasks = useAppStore((s) => s.tasks)
  const togglePinAgent = useAppStore((s) => s.togglePinAgent)
  const appSettings = useAppStore((s) => s.appSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const streamingSessionId = useChatStore((s) => s.streamingSessionId)
  const chatFilter = useAppStore((s) => s.chatFilter ?? 'all')
  const setChatFilter = useAppStore((s) => s.setChatFilter)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const chatroomStreaming = useChatroomStore((s) => s.streamingAgents)
  const [search, setSearch] = useState('')
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const loadSessions = useAppStore((s) => s.loadSessions)

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleBulkDelete = useCallback(async () => {
    // Collect session IDs for selected agents
    const sessionIds = [...selectedIds]
      .map((agentId) => {
        const agent = agents[agentId]
        return agent?.threadSessionId
      })
      .filter(Boolean) as string[]
    if (!sessionIds.length) { toast.error('No chats to delete'); return }
    try {
      await api('DELETE', '/chats', { ids: sessionIds })
      await loadSessions()
      toast.success(`Deleted ${sessionIds.length} chat(s)`)
      setBulkMode(false)
      setSelectedIds(new Set())
    } catch {
      toast.error('Failed to delete chats')
    }
  }, [selectedIds, agents, loadSessions])

  // FLIP animation refs
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map())
  const previousTopRef = useRef<Map<string, number>>(new Map())

  const setRowRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rowRefs.current.set(id, el)
    else rowRefs.current.delete(id)
  }, [])

  useEffect(() => { loadAgents() }, [loadAgents])

  // Build agent list sorted by last activity in their thread session
  const sortedAgents = useMemo(() => {
    return Object.values(agents)
      .filter((a) => {
        if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false
        return true
      })
      .sort((a, b) => {
        const aSession = a.threadSessionId ? sessions[a.threadSessionId] : null
        const bSession = b.threadSessionId ? sessions[b.threadSessionId] : null
        const aTime = (aSession as Session | null)?.lastActiveAt || a.updatedAt
        const bTime = (bSession as Session | null)?.lastActiveAt || b.updatedAt
        return bTime - aTime
      })
  }, [agents, sessions, search])

  // Compute agents active in chatrooms (message in last 30min or currently streaming)
  const chatroomActiveAgentIds = useMemo(() => {
    const set = new Set<string>()
    const cutoff = now ? now - 30 * 60 * 1000 : Number.POSITIVE_INFINITY
    for (const chatroom of Object.values(chatrooms)) {
      for (let i = chatroom.messages.length - 1; i >= 0; i--) {
        const msg = chatroom.messages[i]
        if (msg.time < cutoff) break
        if (msg.role === 'assistant' && msg.senderId !== 'user') set.add(msg.senderId)
      }
    }
    for (const agentId of chatroomStreaming.keys()) set.add(agentId)
    return set
  }, [chatrooms, chatroomStreaming, now])

  // Compute running tasks per agent
  const runningAgentIds = useMemo(() => {
    const set = new Set<string>()
    for (const task of Object.values(tasks)) {
      if (task.status === 'running' && task.agentId) set.add(task.agentId)
    }
    return set
  }, [tasks])

  // Apply chatFilter
  const filteredAgents = useMemo(() => {
    if (chatFilter === 'all') return sortedAgents
    if (!now) return sortedAgents
    return sortedAgents.filter((a) => {
      const threadSession = a.threadSessionId ? sessions[a.threadSessionId] as Session | undefined : undefined
      const isRunning = runningAgentIds.has(a.id) || (threadSession?.active ?? false)
      const isStreaming = streamingSessionId === a.threadSessionId
      const isChatroomActive = chatroomActiveAgentIds.has(a.id)
      if (chatFilter === 'active') return isRunning || isStreaming || isChatroomActive
      // 'recent' — activity within 24h
      const lastActive = threadSession?.lastActiveAt || a.updatedAt
      return now - lastActive < 86_400_000
    })
  }, [sortedAgents, chatFilter, sessions, runningAgentIds, streamingSessionId, chatroomActiveAgentIds, now])

  const defaultAgent = useMemo(() => {
    const id = appSettings.defaultAgentId
    return id ? agents[id] || null : null
  }, [appSettings.defaultAgentId, agents])

  const defaultAgentVisible = !!defaultAgent && filteredAgents.some((agent) => agent.id === defaultAgent.id)
  const listAgents = useMemo(
    () => (defaultAgentVisible ? filteredAgents.filter((agent) => agent.id !== defaultAgent?.id) : filteredAgents),
    [defaultAgent?.id, defaultAgentVisible, filteredAgents],
  )

  // FLIP: animate row position changes
  useLayoutEffect(() => {
    const prevTop = previousTopRef.current
    for (const agent of filteredAgents) {
      const el = rowRefs.current.get(agent.id)
      if (!el) continue
      const newTop = el.getBoundingClientRect().top
      const oldTop = prevTop.get(agent.id)
      if (oldTop !== undefined && oldTop !== newTop) {
        const delta = oldTop - newTop
        el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        )
      }
      prevTop.set(agent.id, newTop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredAgents.map((a) => a.id).join(',')])

  const handleSelect = async (agent: Agent) => {
    if (agent.disabled === true && !agent.threadSessionId) {
      toast.error(`${agent.name} is disabled. Re-enable it to start a new chat.`)
      return
    }
    await setCurrentAgent(agent.id)
    // Load messages for the thread
    const state = useAppStore.getState()
    if (state.currentSessionId) {
      try {
        const msgs = await fetchMessages(state.currentSessionId)
        setMessages(msgs)
      } catch (err: unknown) {
        console.error('[agent-chat-list] Failed to load messages:', err instanceof Error ? err.message : String(err))
      }
    }
    onSelect?.()
    // Delay scroll so React renders the new messages first
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
      }, 100)
    }
  }

  if (!sortedAgents.length && !search) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-accent-soft flex items-center justify-center mb-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
        <p className="font-display text-[15px] font-600 text-text-2">No agents yet</p>
        <p className="text-[13px] text-text-3/50">Create agents to start chatting</p>
        {!inSidebar && (
          <button
            onClick={() => setAgentSheetOpen(true)}
            className="mt-3 px-8 py-3 rounded-[14px] border-none bg-accent-bright text-white
              text-[14px] font-600 cursor-pointer active:scale-95 transition-all duration-200
              shadow-[0_4px_16px_rgba(99,102,241,0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            + New Agent
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Filter control + bulk mode toggle */}
      {sortedAgents.length > 2 && (
        <div className="flex items-center gap-1 px-4 pt-2.5 pb-1">
          {(['all', 'active', 'recent'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setChatFilter(f)}
              data-active={chatFilter === f || undefined}
              className="label-mono px-2.5 py-1 rounded-[6px] border-none cursor-pointer transition-colors
                data-[active]:bg-accent-soft data-[active]:text-accent-bright
                bg-transparent text-text-3 hover:text-text-2 hover:bg-white/[0.04]"
            >
              {f}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setBulkMode(!bulkMode); setSelectedIds(new Set()) }}
            aria-label={bulkMode ? 'Exit selection mode' : 'Select chats'}
            className={`ml-auto label-mono px-2.5 py-1 rounded-[6px] border-none cursor-pointer transition-colors
              ${bulkMode ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2 hover:bg-white/[0.04]'}`}
          >
            {bulkMode ? 'Cancel' : 'Select'}
          </button>
        </div>
      )}
      {/* Bulk action bar */}
      {bulkMode && selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-white/[0.02] border-b border-white/[0.04]">
          <span className="text-[12px] text-text-2 font-500 flex-1">{selectedIds.size} selected</span>
          <button
            onClick={() => setConfirmBulkDelete(true)}
            className="px-3 py-1.5 rounded-[8px] border-none bg-red-500/10 text-red-400 text-[12px] font-600 cursor-pointer hover:bg-red-500/20 transition-colors"
            style={{ fontFamily: 'inherit' }}
          >
            Delete
          </button>
        </div>
      )}
      {(sortedAgents.length > 5 || search) && (
        <div className="px-4 py-2.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
              text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}
      <div className="flex flex-col gap-0.5 px-2 pb-4">
        {defaultAgentVisible && defaultAgent && (() => {
          const threadSession = defaultAgent.threadSessionId ? sessions[defaultAgent.threadSessionId] as Session | undefined : undefined
          const lastMsg = threadSession?.messages?.at(-1)
          const heartbeatOn = defaultAgent.heartbeatEnabled === true && (defaultAgent.plugins?.length ?? 0) > 0
          const recentlyActive = !!now && (threadSession?.lastActiveAt ?? 0) > now - 30 * 60 * 1000
          const isDisabled = defaultAgent.disabled === true
          const isWorking = !isDisabled && (runningAgentIds.has(defaultAgent.id) || (threadSession?.active ?? false) || heartbeatOn || recentlyActive || chatroomActiveAgentIds.has(defaultAgent.id))
          const isTyping = streamingSessionId === defaultAgent.threadSessionId
          const preview = lastMsg?.text?.slice(0, 100)?.replace(/\n/g, ' ') || 'Your primary shortcut chat.'
          const isActive = currentAgentId === defaultAgent.id

          return (
            <div className="mb-2 px-2">
              <div className="px-2 pb-1 text-[10px] font-700 uppercase tracking-[0.12em] text-accent-bright/65">
                Default Agent
              </div>
              <div
                className={`group/row relative w-full text-left py-3.5 px-4 rounded-[14px] cursor-pointer transition-all duration-150 border
                  ${isActive
                    ? 'bg-accent-soft border-accent-bright/25'
                    : 'bg-accent-soft/40 border-accent-bright/15 hover:bg-accent-soft/55'}`}
                onClick={() => bulkMode ? toggleSelected(defaultAgent.id) : handleSelect(defaultAgent)}
              >
                <div className="flex items-center gap-3">
                  {bulkMode && (
                    <div className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center shrink-0 transition-colors
                      ${selectedIds.has(defaultAgent.id) ? 'bg-accent-bright border-accent-bright' : 'border-white/20 bg-transparent'}`}>
                      {selectedIds.has(defaultAgent.id) && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  )}
                  <div className="relative shrink-0">
                    <AgentAvatar seed={defaultAgent.avatarSeed || null} avatarUrl={defaultAgent.avatarUrl} name={defaultAgent.name} size={38} />
                    <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg ${
                      isWorking ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]' : 'bg-text-3/30'
                    }`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-[14px] font-700 truncate text-text tracking-[-0.01em]">
                        {defaultAgent.name}
                      </span>
                      {isDisabled && (
                        <span className="px-1.5 py-0.5 rounded-[6px] bg-amber-400/[0.08] text-amber-300 text-[9px] font-700 uppercase tracking-[0.08em]">
                          Disabled
                        </span>
                      )}
                      <span className="px-1.5 py-0.5 rounded-[6px] bg-accent-bright/12 text-accent-bright text-[9px] font-700 uppercase tracking-[0.08em]">
                        Shortcut
                      </span>
                    </div>
                    {isTyping ? (
                      <div className="text-[12px] text-accent-bright/80 mt-1 flex items-center gap-1.5">
                        <span className="flex gap-0.5">
                          <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:0ms]" />
                          <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:150ms]" />
                          <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:300ms]" />
                        </span>
                        Typing...
                      </div>
                    ) : (
                      <div className="text-[12px] text-text-3/70 mt-1 truncate">
                        {preview}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      await updateSettings({ defaultAgentId: null })
                      toast.success('Default agent cleared')
                    }}
                    aria-label="Remove as default agent"
                    title="Default agent — click to clear"
                    className="shrink-0 p-1 rounded-[6px] transition-all bg-transparent border-none cursor-pointer hover:bg-white/[0.06] text-accent-bright"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      <path d="M9 22V12h6v10" fill="rgba(0,0,0,0.3)" stroke="none" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
        {listAgents.map((agent) => {
          const threadSession = agent.threadSessionId ? sessions[agent.threadSessionId] as Session | undefined : undefined
          const lastMsg = threadSession?.messages?.at(-1)
          const isActive = currentAgentId === agent.id
          const heartbeatOn = agent.heartbeatEnabled === true && (agent.plugins?.length ?? 0) > 0
          const recentlyActive = !!now && (threadSession?.lastActiveAt ?? 0) > now - 30 * 60 * 1000
          const isDisabled = agent.disabled === true
          const isWorking = !isDisabled && (runningAgentIds.has(agent.id) || (threadSession?.active ?? false) || heartbeatOn || recentlyActive || chatroomActiveAgentIds.has(agent.id))
          const isTyping = streamingSessionId === agent.threadSessionId
          const preview = lastMsg?.text?.slice(0, 80)?.replace(/\n/g, ' ') || ''

          return (
            <div
              key={agent.id}
              ref={(el) => setRowRef(agent.id, el)}
              className={`group/row relative w-full text-left py-3 px-4 rounded-[12px] cursor-pointer transition-all duration-150 border-none
                ${isActive
                  ? 'bg-accent-soft/80 border border-accent-bright/20'
                  : 'bg-transparent hover:bg-white/[0.02]'}`}
              onClick={() => bulkMode ? toggleSelected(agent.id) : handleSelect(agent)}
            >
              <div className="flex items-center gap-2.5">
                {bulkMode && (
                  <div className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center shrink-0 transition-colors
                    ${selectedIds.has(agent.id) ? 'bg-accent-bright border-accent-bright' : 'border-white/20 bg-transparent'}`}>
                    {selectedIds.has(agent.id) && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                )}
                <div className="relative shrink-0">
                  <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={36} />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg ${
                    isWorking ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]' : 'bg-text-3/30'
                  }`} />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[13.5px] font-600 truncate flex-1 tracking-[-0.01em]">
                      {agent.name}
                    </span>
                    {isDisabled && (
                      <span className="px-1.5 py-0.5 rounded-[6px] bg-amber-400/[0.08] text-amber-300 text-[9px] font-700 uppercase tracking-[0.08em] shrink-0">
                        Disabled
                      </span>
                    )}
                    {appSettings.defaultAgentId === agent.id && (
                      <span className="px-1.5 py-0.5 rounded-[6px] bg-accent-bright/10 text-accent-bright text-[9px] font-700 uppercase tracking-[0.08em] shrink-0">
                        Default
                      </span>
                    )}
                    <span className="text-[10px] text-text-3/60 font-mono shrink-0">
                      {(threadSession?.model || agent.model)
                        ? (threadSession?.model || agent.model)!.split('/').pop()?.split(':')[0]
                        : agent.provider}
                    </span>
                    {/* Set as default agent */}
                    {(() => {
                      const isDefault = appSettings.defaultAgentId === agent.id
                      return (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (isDefault) {
                              await updateSettings({ defaultAgentId: null })
                              toast.success('Default agent cleared')
                            } else {
                              await updateSettings({ defaultAgentId: agent.id })
                              toast.success(`${agent.name} set as default`)
                            }
                          }}
                          aria-label={isDefault ? 'Remove as default' : 'Set as default agent'}
                          title={isDefault ? 'Default agent — click to clear' : 'Set as default agent'}
                          className={`shrink-0 p-1 rounded-[6px] transition-all bg-transparent border-none cursor-pointer hover:bg-white/[0.06]
                            ${isDefault ? 'opacity-100 text-accent-bright' : 'opacity-0 group-hover/row:opacity-60 hover:!opacity-100 text-text-3'}`}
                          style={{ fontFamily: 'inherit' }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill={isDefault ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                            {isDefault && <path d="M9 22V12h6v10" fill="rgba(0,0,0,0.3)" stroke="none" />}
                          </svg>
                        </button>
                      )
                    })()}
                    {/* Pin button — inline after model label */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        togglePinAgent(agent.id)
                        toast.success(agent.pinned ? 'Agent unpinned' : 'Agent pinned')
                      }}
                      aria-label={agent.pinned ? 'Unpin agent' : 'Pin agent'}
                      className={`shrink-0 p-1 rounded-[6px] transition-all bg-transparent border-none cursor-pointer hover:bg-white/[0.06]
                        ${agent.pinned ? 'opacity-100 text-amber-400' : 'opacity-0 group-hover/row:opacity-60 hover:!opacity-100 text-text-3'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill={agent.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </button>
                  </div>
                  {isTyping ? (
                    <div className="text-[12px] text-accent-bright/70 mt-0.5 flex items-center gap-1.5">
                      <span className="flex gap-0.5">
                        <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:0ms]" />
                        <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:150ms]" />
                        <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:300ms]" />
                      </span>
                      Typing...
                    </div>
                  ) : preview ? (
                    <div className="text-[12px] text-text-3/70 mt-0.5 truncate">
                      {preview}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete Chats"
        message={`Delete ${selectedIds.size} chat(s)? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => { setConfirmBulkDelete(false); handleBulkDelete() }}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </div>
  )
}
