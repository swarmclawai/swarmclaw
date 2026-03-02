'use client'

import { useEffect, useCallback, useMemo, useState } from 'react'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import type { Chatroom } from '@/types'
import { EmptyState } from '@/components/shared/empty-state'

export function ChatroomList() {
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const currentChatroomId = useChatroomStore((s) => s.currentChatroomId)
  const loadChatrooms = useChatroomStore((s) => s.loadChatrooms)
  const setCurrentChatroom = useChatroomStore((s) => s.setCurrentChatroom)
  const setChatroomSheetOpen = useChatroomStore((s) => s.setChatroomSheetOpen)
  const setEditingChatroomId = useChatroomStore((s) => s.setEditingChatroomId)
  const agents = useAppStore((s) => s.agents)

  const refresh = useCallback(() => {
    loadChatrooms()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useWs('chatrooms', refresh, 15_000)

  // Auto-select the latest chatroom when none is selected
  useEffect(() => {
    if (currentChatroomId) return
    const latest = Object.values(chatrooms).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) setCurrentChatroom(latest.id)
  }, [chatrooms, currentChatroomId, setCurrentChatroom])

  const [filter, setFilter] = useState<'all' | 'active' | 'recent'>('all')

  const sorted = useMemo(() =>
    Object.values(chatrooms).sort(
      (a: Chatroom, b: Chatroom) => b.updatedAt - a.updatedAt
    ), [chatrooms])

  const filtered = useMemo(() => {
    if (filter === 'all') return sorted
    const now = Date.now()
    return sorted.filter((c) => {
      if (filter === 'active') return now - c.updatedAt < 3_600_000 // 1h
      return now - c.updatedAt < 86_400_000 // 24h
    })
  }, [sorted, filter])

  return (
    <div className="flex-1 overflow-y-auto">
      {sorted.length === 0 ? (
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
        <div className="p-3 space-y-1">
          {sorted.length > 2 && (
            <div className="flex items-center gap-1 px-1 pb-2">
              {(['all', 'active', 'recent'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  data-active={filter === f || undefined}
                  className="px-3 py-1.5 rounded-[8px] text-[11px] font-600 border-none cursor-pointer transition-all focus-visible:ring-1 focus-visible:ring-accent-bright/50
                    data-[active]:bg-accent-soft data-[active]:text-accent-bright
                    bg-transparent text-text-3 hover:text-text-2 hover:bg-white/[0.04]"
                >
                  {f}
                </button>
              ))}
            </div>
          )}
          {filtered.map((chatroom) => {
            const isActive = chatroom.id === currentChatroomId
            const memberNames = chatroom.agentIds
              .map((id) => agents[id]?.name)
              .filter(Boolean)
              .slice(0, 3)
            const lastMsg = chatroom.messages[chatroom.messages.length - 1]

            return (
              <button
                key={chatroom.id}
                onClick={() => setCurrentChatroom(chatroom.id)}
                className={`w-full text-left py-3.5 px-4 rounded-[14px] transition-all cursor-pointer group border border-transparent ${
                  isActive
                    ? 'bg-accent-soft/60'
                    : 'hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <div className="w-7 h-7 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <span className={`text-[13px] font-600 truncate ${isActive ? 'text-accent-bright' : 'text-text'}`}>
                    {chatroom.name}
                  </span>
                  <span className="label-mono ml-auto shrink-0">
                    {chatroom.agentIds.length} agents
                  </span>
                </div>
                {memberNames.length > 0 && (
                  <p className="text-[11px] text-text-3 truncate pl-9">
                    {memberNames.join(', ')}{chatroom.agentIds.length > 3 ? ` +${chatroom.agentIds.length - 3}` : ''}
                  </p>
                )}
                {lastMsg && (
                  <p className="text-[11px] text-text-3/70 truncate pl-9 mt-0.5">
                    {lastMsg.senderName}: {lastMsg.text.slice(0, 60)}
                  </p>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
