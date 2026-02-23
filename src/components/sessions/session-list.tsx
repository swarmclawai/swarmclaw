'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { SessionCard } from './session-card'
import { fetchMessages } from '@/lib/sessions'

interface Props {
  inSidebar?: boolean
  onSelect?: () => void
}

type SessionFilter = 'all' | 'active' | 'human' | 'orchestrated'

export function SessionList({ inSidebar, onSelect }: Props) {
  const sessions = useAppStore((s) => s.sessions)
  const currentUser = useAppStore((s) => s.currentUser)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)
  const clearSessions = useAppStore((s) => s.clearSessions)
  const setMessages = useChatStore((s) => s.setMessages)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<SessionFilter>('all')

  useEffect(() => {
    void loadConnectors()
  }, [loadConnectors])

  const allUserSessions = useMemo(() => {
    return Object.values(sessions).filter((s) => {
      if (s.name === '__main__') return false
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
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  }, [allUserSessions, search, typeFilter])

  const handleSelect = async (id: string) => {
    setCurrentSession(id)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('agent-ember:scroll-bottom'))
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
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-primary/10 flex items-center justify-center mb-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
            <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
          </svg>
        </div>
        <p className="font-display text-[15px] font-600 text-text-2">No sessions yet</p>
        <p className="text-[13px] text-text-3/50">Create one to start chatting</p>
        <button
          onClick={() => setNewSessionOpen(true)}
          className="mt-4 px-8 py-3 rounded-[14px] border-none bg-primary text-primary-foreground
            text-[14px] font-600 cursor-pointer active:scale-95 transition-all duration-200
            shadow-[0_4px_16px_rgba(var(--primary-rgb),0.25)] flex items-center gap-2"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Session
        </button>
      </div>
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
              ${typeFilter === f ? 'bg-primary/10 text-primary' : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {f === 'all' ? 'All' : f === 'active' ? 'Active' : f === 'human' ? 'Human' : 'AI'}
          </button>
        ))}
        {filtered.length > 0 && (
          <button
            onClick={async () => {
              if (!window.confirm(`Delete ${filtered.length} session${filtered.length === 1 ? '' : 's'}?`)) return
              await clearSessions(filtered.map((s) => s.id))
            }}
            className="ml-auto p-1.5 rounded-[8px] text-text-3/40 hover:text-red-400 hover:bg-red-400/[0.06]
              cursor-pointer transition-all bg-transparent border-none"
            title="Clear all sessions"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        )}
      </div>

      {(filtered.length > 3 || search) && (
        <div className="px-4 py-2.5 shrink-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
              text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/40 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}

      {filtered.length > 0 ? (
        <div className="flex flex-col gap-1 px-2 pb-4">
          {filtered.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              active={s.id === currentSessionId}
              onClick={() => handleSelect(s.id)}
            />
          ))}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center">
          <p className="text-[13px] text-text-3/50">
            No {typeFilter === 'orchestrated' ? 'AI' : typeFilter === 'active' ? 'active' : typeFilter} sessions{search ? ` matching "${search}"` : ''}
          </p>
        </div>
      )}
    </div>
  )
}
