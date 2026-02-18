'use client'

import { useMemo, useState } from 'react'
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
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)
  const setMessages = useChatStore((s) => s.setMessages)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<SessionFilter>('all')

  const allUserSessions = useMemo(() => {
    return Object.values(sessions).filter((s) => {
      if (s.user !== currentUser && !((!s.user) && currentUser === 'wayde') && s.user !== 'system') return false
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
    try {
      const msgs = await fetchMessages(id)
      setMessages(msgs)
    } catch {
      setMessages(sessions[id]?.messages || [])
    }
    onSelect?.()
  }

  // Truly empty — no sessions at all for this user
  if (!allUserSessions.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-accent-soft flex items-center justify-center mb-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-accent-bright">
            <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
          </svg>
        </div>
        <p className="font-display text-[15px] font-600 text-text-2">No sessions yet</p>
        <p className="text-[13px] text-text-3/50">Create one to start chatting</p>
        {!inSidebar && (
          <button
            onClick={() => setNewSessionOpen(true)}
            className="mt-3 px-8 py-3 rounded-[14px] border-none bg-[#6366F1] text-white
              text-[14px] font-600 cursor-pointer active:scale-95 transition-all duration-200
              shadow-[0_4px_16px_rgba(99,102,241,0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            + New Session
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Filter tabs — always visible when sessions exist */}
      <div className="flex gap-1 px-4 pt-2 pb-1 shrink-0">
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
