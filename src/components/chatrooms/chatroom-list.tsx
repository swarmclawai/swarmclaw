'use client'

import { useEffect, useCallback, useMemo, useState } from 'react'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useAppStore } from '@/stores/use-app-store'
import { useNow } from '@/hooks/use-now'
import { useWs } from '@/hooks/use-ws'
import type { Chatroom } from '@/types'
import { EmptyState } from '@/components/shared/empty-state'

function formatRoomTime(ts: number, now: number | null): string {
  if (!now) return 'recently'
  const diff = now - ts
  if (diff < 60_000) return 'Now'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ChatroomList() {
  const now = useNow()
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const currentChatroomId = useChatroomStore((s) => s.currentChatroomId)
  const loadChatrooms = useChatroomStore((s) => s.loadChatrooms)
  const setCurrentChatroom = useChatroomStore((s) => s.setCurrentChatroom)
  const setChatroomSheetOpen = useChatroomStore((s) => s.setChatroomSheetOpen)
  const setEditingChatroomId = useChatroomStore((s) => s.setEditingChatroomId)
  const agents = useAppStore((s) => s.agents)
  const lastReadTimestamps = useAppStore((s) => s.lastReadTimestamps)
  const [filter, setFilter] = useState<'all' | 'active' | 'recent' | 'unread'>('all')
  const [search, setSearch] = useState('')

  const refresh = useCallback(() => {
    loadChatrooms()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useWs('chatrooms', refresh, 15_000)

  useEffect(() => {
    if (currentChatroomId) return
    const latest = Object.values(chatrooms).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) setCurrentChatroom(latest.id)
  }, [chatrooms, currentChatroomId, setCurrentChatroom])

  const enriched = useMemo(() => (
    Object.values(chatrooms)
      .map((chatroom: Chatroom) => {
        const memberNames = chatroom.agentIds
          .map((id) => agents[id]?.name)
          .filter(Boolean)
        const lastMsg = chatroom.messages[chatroom.messages.length - 1]
        const lastReadAt = lastReadTimestamps[chatroom.id] || 0
        const unreadCount = chatroom.messages.filter(
          (msg) => msg.senderId !== 'user' && msg.senderId !== 'system' && (msg.time || 0) > lastReadAt,
        ).length

        return {
          chatroom,
          memberNames,
          lastMsg,
          unreadCount,
          searchText: [
            chatroom.name,
            chatroom.description,
            memberNames.join(' '),
            lastMsg?.senderName,
            lastMsg?.text,
          ].filter(Boolean).join(' ').toLowerCase(),
        }
      })
      .sort((a, b) => b.chatroom.updatedAt - a.chatroom.updatedAt)
  ), [agents, chatrooms, lastReadTimestamps])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return enriched.filter((item) => {
      if (query && !item.searchText.includes(query)) return false
      if (!now) return filter === 'unread' ? item.unreadCount > 0 : true
      if (filter === 'active') return now - item.chatroom.updatedAt < 3_600_000
      if (filter === 'recent') return now - item.chatroom.updatedAt < 86_400_000
      if (filter === 'unread') return item.unreadCount > 0
      return true
    })
  }, [enriched, filter, now, search])

  return (
    <div className="flex-1 overflow-y-auto">
      {enriched.length === 0 ? (
        <EmptyState
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-accent-bright">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" />
            </svg>
          }
          title="No chatrooms yet"
          subtitle="Create one to start a group chat"
          action={{ label: '+ New Chatroom', onClick: () => { setEditingChatroomId(null); setChatroomSheetOpen(true) } }}
        />
      ) : (
        <div className="p-3 space-y-3">
          <div className="space-y-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search rooms, members, or recent messages..."
              className="w-full rounded-[12px] border border-white/[0.06] bg-surface px-3 py-2.5 text-[13px] text-text placeholder:text-text-3/70 focus:outline-none focus:border-accent-bright/35"
            />
            <div className="flex flex-wrap items-center gap-1">
              {(['all', 'active', 'recent', 'unread'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  data-active={filter === value || undefined}
                  className="rounded-[8px] border-none px-3 py-1.5 text-[11px] font-600 capitalize cursor-pointer transition-all focus-visible:ring-1 focus-visible:ring-accent-bright/50
                    data-[active]:bg-accent-soft data-[active]:text-accent-bright
                    bg-transparent text-text-3 hover:text-text-2 hover:bg-white/[0.04]"
                >
                  {value}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-text-3/55">
                {filtered.length} room{filtered.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-8 text-center">
              <div className="text-[13px] font-600 text-text-2">No rooms match this view</div>
              <div className="mt-1 text-[12px] text-text-3/65">
                Clear the search or switch filters to see more chatrooms.
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map(({ chatroom, memberNames, lastMsg, unreadCount }, idx) => {
                const isActive = chatroom.id === currentChatroomId
                return (
                  <button
                    key={chatroom.id}
                    onClick={() => setCurrentChatroom(chatroom.id)}
                    className={`relative w-full overflow-hidden rounded-[14px] border px-4 py-3.5 text-left transition-all cursor-pointer ${
                      isActive
                        ? 'border-accent-bright/20 bg-accent-soft/55'
                        : 'border-transparent hover:bg-white/[0.04] hover:border-white/[0.05]'
                    }`}
                    style={{
                      animation: 'fade-up 0.4s var(--ease-spring) both',
                      animationDelay: `${idx * 0.03}s`,
                    }}
                  >
                    {isActive && (
                      <div className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-accent-bright" />
                    )}
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft shrink-0">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`truncate text-[13px] font-700 ${isActive ? 'text-accent-bright' : 'text-text'}`}>
                            {chatroom.name}
                          </span>
                          {unreadCount > 0 && (
                            <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent-bright px-1.5 py-0.5 text-[10px] font-700 text-white">
                              {unreadCount > 99 ? '99+' : unreadCount}
                            </span>
                          )}
                          <span className="ml-auto shrink-0 text-[10px] font-mono text-text-3/55">
                            {formatRoomTime(lastMsg?.time || chatroom.updatedAt, now)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-text-3">
                          <span>{chatroom.agentIds.length} agent{chatroom.agentIds.length === 1 ? '' : 's'}</span>
                          {chatroom.chatMode === 'parallel' && (
                            <span className="rounded-[6px] bg-sky-500/10 px-1.5 py-0.5 text-sky-300">Parallel</span>
                          )}
                          {chatroom.autoAddress && (
                            <span className="rounded-[6px] bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">Auto-address</span>
                          )}
                        </div>
                        {memberNames.length > 0 && (
                          <p className="mt-1 truncate text-[11px] text-text-3/80">
                            {memberNames.slice(0, 3).join(', ')}{memberNames.length > 3 ? ` +${memberNames.length - 3}` : ''}
                          </p>
                        )}
                        {lastMsg && (
                          <p className="mt-1 truncate text-[11px] text-text-3/65">
                            {lastMsg.senderName}: {lastMsg.text.slice(0, 72)}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
