'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { ChatCard } from './chat-card'
import { getSessionLastAssistantAt, getSessionLastMessage, getSessionMessageCount } from '@/lib/chat/session-summary'
import { isLocalhostBrowser, isVisibleSessionForViewer } from '@/lib/observability/local-observability'
import { toast } from 'sonner'
import { Skeleton } from '@/components/shared/skeleton'
import { EmptyState } from '@/components/shared/empty-state'
import { Dropdown, DropdownItem } from '@/components/shared/dropdown'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { SearchInput } from '@/components/ui/search-input'

interface Props {
  inSidebar?: boolean
  onSelect?: () => void
}

type SessionFilter = 'all' | 'active' | 'unread'
type SortMode = 'lastActive' | 'name' | 'messages'

export function ChatList({ inSidebar, onSelect }: Props) {
  const sessions = useAppStore((s) => s.sessions)
  const currentUser = useAppStore((s) => s.currentUser)
  const currentSessionId = useAppStore(selectActiveSessionId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const clearSessions = useAppStore((s) => s.clearSessions)
  const togglePinSession = useAppStore((s) => s.togglePinSession)
  const markChatRead = useAppStore((s) => s.markChatRead)
  const lastReadTimestamps = useAppStore((s) => s.lastReadTimestamps)
  const agents = useAppStore((s) => s.agents)
  const connectors = useAppStore((s) => s.connectors)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<SessionFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('lastActive')
  const [loaded, setLoaded] = useState(Object.keys(sessions).length > 0)
  const [showLocalPlatformSessions, setShowLocalPlatformSessions] = useState(false)
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const [confirmClearIds, setConfirmClearIds] = useState<string[] | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (Object.keys(sessions).length > 0 && !loaded) setLoaded(true)
  }, [sessions, loaded])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConnectors()
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [loadConnectors])

  useEffect(() => {
    setShowLocalPlatformSessions(isLocalhostBrowser())
  }, [])

  const allUserSessions = useMemo(() => {
    return Object.values(sessions).filter((s) => isVisibleSessionForViewer(s, currentUser, {
      localhost: showLocalPlatformSessions,
    }))
  }, [sessions, currentUser, showLocalPlatformSessions])

  const filtered = useMemo(() => {
    return allUserSessions
      .filter((s) => {
        const unreadCount = (getSessionLastAssistantAt(s) || 0) > (lastReadTimestamps[s.id] || 0) ? 1 : 0
        if (search) {
          const agent = s.agentId ? agents[s.agentId] : null
          const connector = Object.values(connectors).find((item) => item.chatroomId == null && item.agentId === s.agentId && item.isEnabled !== false)
          const lastMessage = getSessionLastMessage(s)
          const haystack = [
            s.name,
            agent?.name,
            s.provider,
            s.model,
            s.cwd,
            connector?.name,
            connector?.platform,
            lastMessage?.text,
            lastMessage?.source?.senderName,
            lastMessage?.source?.platform,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(search.toLowerCase())) return false
        }
        if (typeFilter === 'active' && !s.active) return false
        if (typeFilter === 'unread' && unreadCount === 0) return false
        return true
      })
      .sort((a, b) => {
        // Pinned always first
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        // Then by sort mode
        if (sortMode === 'name') return a.name.localeCompare(b.name)
        if (sortMode === 'messages') return getSessionMessageCount(b) - getSessionMessageCount(a)
        return (b.lastActiveAt || 0) - (a.lastActiveAt || 0)
      })
  }, [agents, allUserSessions, connectors, lastReadTimestamps, search, sortMode, typeFilter])

  const handleSelect = async (id: string) => {
    const agentId = sessions[id]?.agentId
    if (agentId) void setCurrentAgent(agentId)
    markChatRead(id)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
    onSelect?.()
  }

  const handleClearFiltered = async () => {
    if (!confirmClearIds || confirmClearIds.length === 0) return
    setClearing(true)
    try {
      await clearSessions(confirmClearIds)
      toast.success(`${confirmClearIds.length} chat${confirmClearIds.length === 1 ? '' : 's'} deleted`)
      setConfirmClearIds(null)
    } finally {
      setClearing(false)
    }
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
        subtitle="Create an agent to open its persistent thread"
        action={!inSidebar ? { label: '+ New Agent', onClick: () => setAgentSheetOpen(true) } : undefined}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Filter tabs — always visible when sessions exist */}
      <div className="flex items-center gap-1 px-4 pt-2 pb-1 shrink-0">
        {(['all', 'active', 'unread'] as SessionFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setTypeFilter(f)}
            className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all
              ${typeFilter === f ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Unread'}
          </button>
        ))}
        {filtered.length > 0 && (
          <div className="ml-auto relative">
            <button
              onClick={() => setBulkMenuOpen((open) => !open)}
              className="p-1.5 rounded-[8px] text-text-3/70 hover:text-text-2 hover:bg-white/[0.04]
                cursor-pointer transition-all bg-transparent border-none"
              title="More actions"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="19" cy="12" r="1.75" />
              </svg>
            </button>
            <Dropdown open={bulkMenuOpen} onClose={() => setBulkMenuOpen(false)}>
              <DropdownItem onClick={() => {
                setBulkMenuOpen(false)
                setConfirmClearIds(filtered.map((s) => s.id))
              }}>
                Clear filtered chats
              </DropdownItem>
            </Dropdown>
          </div>
        )}
      </div>

      {/* Search — always visible */}
      <div className="px-4 py-2 shrink-0 flex gap-2">
        <SearchInput
          size="sm"
          className="flex-1"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          placeholder="Search..."
          aria-label="Search chats"
          data-testid="chat-search"
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
            No {typeFilter === 'active' ? 'active' : typeFilter} chats{search ? ` matching "${search}"` : ''}
          </p>
        </div>
      )}
      <ConfirmDialog
        open={!!confirmClearIds}
        title="Clear Filtered Chats?"
        message={confirmClearIds ? `Delete ${confirmClearIds.length} chat${confirmClearIds.length === 1 ? '' : 's'} from the current view?` : 'Delete filtered chats?'}
        confirmLabel={clearing ? 'Deleting...' : 'Delete'}
        confirmDisabled={clearing}
        cancelDisabled={clearing}
        danger
        onConfirm={() => { void handleClearFiltered() }}
        onCancel={() => { if (!clearing) setConfirmClearIds(null) }}
      />
    </div>
  )
}
