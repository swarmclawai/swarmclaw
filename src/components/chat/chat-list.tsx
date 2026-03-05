'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { ChatCard } from './chat-card'
import { fetchMessages } from '@/lib/chats'
import { toast } from 'sonner'
import { Skeleton } from '@/components/shared/skeleton'
import { EmptyState } from '@/components/shared/empty-state'

interface Props {
  inSidebar?: boolean
  onSelect?: () => void
}

type SessionFilter = 'all' | 'active' | 'human' | 'orchestrated'
type SortMode = 'lastActive' | 'name' | 'messages'

export function ChatList({ inSidebar, onSelect }: Props) {
  const sessions = useAppStore((s) => s.sessions)
  const currentUser = useAppStore((s) => s.currentUser)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)
  const clearSessions = useAppStore((s) => s.clearSessions)
  const togglePinSession = useAppStore((s) => s.togglePinSession)
  const markChatRead = useAppStore((s) => s.markChatRead)
  const setMessages = useChatStore((s) => s.setMessages)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<SessionFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('lastActive')
  const [loaded, setLoaded] = useState(Object.keys(sessions).length > 0)

  useEffect(() => {
    if (Object.keys(sessions).length > 0 && !loaded) setLoaded(true)
  }, [sessions, loaded])

  useEffect(() => {
    void loadConnectors()
  }, [loadConnectors])

  const allUserSessions = useMemo(() => {
    return Object.values(sessions).filter((s) => {
      const owner = (s.user || '').toLowerCase()
      const isPlatformOwned = owner === 'system' || owner === 'connector' || owner === 'swarm'
      const isCurrentUserOwned = !!currentUser && owner === currentUser.toLowerCase()
      const isUnownedLegacy = !owner
      if (!isCurrentUserOwned && !isPlatformOwned && !isUnownedLegacy) return false
      return true
    })
  }, [sessions, currentUser])

  const filtered = useMemo(() => {
    return allUserSessions
      .filter((s) => {
        if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
        if (typeFilter === 'active' && !s.active) return false
        if (typeFilter === 'human' && s.sessionType === 'orchestrated') return false
        if (typeFilter === 'orchestrated' && s.sessionType !== 'orchestrated') return false
        return true
      })
      .sort((a, b) => {
        // Pinned always first
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        // Then by sort mode
        if (sortMode === 'name') return a.name.localeCompare(b.name)
        if (sortMode === 'messages') return (b.messages?.length || 0) - (a.messages?.length || 0)
        return (b.lastActiveAt || 0) - (a.lastActiveAt || 0)
      })
  }, [allUserSessions, search, typeFilter, sortMode])

  const handleSelect = async (id: string) => {
    setCurrentSession(id)
    markChatRead(id)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
    try {
      const msgs = await fetchMessages(id)
      setMessages(msgs)
    } catch {
      setMessages(sessions[id]?.messages || [])
    }
    await loadSessions()
    onSelect?.()
  }

  // Truly empty — no sessions at all for this user
  if (!allUserSessions.length) {
    // Show skeleton cards while data is loading
    if (!loaded) {
      return (
        <div className="flex-1 flex flex-col gap-1 px-2 pt-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="py-3 px-4 rounded-[14px]">
              <div className="flex items-center gap-2.5">
                <Skeleton className="rounded-full" width={28} height={28} />
                <Skeleton className="rounded-[6px]" width={140} height={14} />
              </div>
              <Skeleton className="rounded-[6px] mt-2" width="70%" height={12} />
            </div>
          ))}
        </div>
      )
    }
    return (
      <EmptyState
        icon={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-accent-bright">
            <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
          </svg>
        }
        title="No chats yet"
        subtitle="Create one to start chatting"
        action={!inSidebar ? { label: '+ New Chat', onClick: () => setNewSessionOpen(true) } : undefined}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Filter tabs — always visible when sessions exist */}
      <div className="flex items-center gap-1 px-4 pt-2 pb-1 shrink-0">
        {(['all', 'active', 'human', 'orchestrated'] as SessionFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setTypeFilter(f)}
            className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all
              ${typeFilter === f ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {f === 'all' ? 'All' : f === 'active' ? 'Active' : f === 'human' ? 'Human' : 'AI'}
          </button>
        ))}
        {filtered.length > 0 && (
          <button
            onClick={async () => {
              if (!window.confirm(`Delete ${filtered.length} chat${filtered.length === 1 ? '' : 's'}?`)) return
              await clearSessions(filtered.map((s) => s.id))
              toast.success(`${filtered.length} chat${filtered.length === 1 ? '' : 's'} deleted`)
            }}
            className="ml-auto p-1.5 rounded-[8px] text-text-3/70 hover:text-red-400 hover:bg-red-400/[0.06]
              cursor-pointer transition-all bg-transparent border-none"
            title="Clear all chats"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        )}
      </div>

      {/* Search — always visible */}
      <div className="px-4 py-2 shrink-0 flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="flex-1 px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
            text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow"
          style={{ fontFamily: 'inherit' }}
        />
        {/* Sort dropdown */}
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          aria-label="Sort chats"
          className="px-2 py-2 rounded-[12px] border border-white/[0.04] bg-surface text-text
            text-[11px] outline-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <option value="lastActive">Recent</option>
          <option value="name">Name</option>
          <option value="messages">Messages</option>
        </select>
      </div>

      {filtered.length > 0 ? (
        <div className="flex flex-col gap-1 px-2 pb-4">
          {filtered.map((s) => (
            <div key={s.id} className="group/pin relative">
              <ChatCard
                session={s}
                active={s.id === currentSessionId}
                onClick={() => handleSelect(s.id)}
              />
              <button
                onClick={(e) => { e.stopPropagation(); togglePinSession(s.id); toast.success(s.pinned ? 'Chat unpinned' : 'Chat pinned') }}
                aria-label={s.pinned ? 'Unpin chat' : 'Pin chat'}
                className={`absolute top-2 right-2 p-1 rounded-[6px] border-none cursor-pointer transition-all
                  ${s.pinned
                    ? 'text-amber-400 bg-amber-400/10 opacity-100'
                    : 'text-text-3/50 bg-transparent opacity-0 group-hover/pin:opacity-100 hover:text-text-2 hover:bg-white/[0.04]'}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill={s.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 17v5" />
                  <path d="M9 2h6l-1 7h4l-8 8 2-8H8z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center">
          <p className="text-[13px] text-text-3/50">
            No {typeFilter === 'orchestrated' ? 'AI' : typeFilter === 'active' ? 'active' : typeFilter} chats{search ? ` matching "${search}"` : ''}
          </p>
        </div>
      )}
    </div>
  )
}
