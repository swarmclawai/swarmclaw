'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { fetchMessages } from '@/lib/sessions'
import type { Agent, Session } from '@/types'

interface Props {
  inSidebar?: boolean
  onSelect?: () => void
}

export function AgentChatList({ inSidebar, onSelect }: Props) {
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const setMessages = useChatStore((s) => s.setMessages)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const tasks = useAppStore((s) => s.tasks)
  const [search, setSearch] = useState('')

  useEffect(() => { loadAgents() }, [])

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

  // Compute running tasks per agent
  const runningAgentIds = useMemo(() => {
    const set = new Set<string>()
    for (const task of Object.values(tasks)) {
      if (task.status === 'running' && task.agentId) set.add(task.agentId)
    }
    return set
  }, [tasks])

  const handleSelect = async (agent: Agent) => {
    await setCurrentAgent(agent.id)
    // Load messages for the thread
    const state = useAppStore.getState()
    if (state.currentSessionId) {
      try {
        const msgs = await fetchMessages(state.currentSessionId)
        setMessages(msgs)
      } catch { /* ignore */ }
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
            className="mt-3 px-8 py-3 rounded-[14px] border-none bg-[#6366F1] text-white
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
      {(sortedAgents.length > 5 || search) && (
        <div className="px-4 py-2.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
              text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/40 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}
      <div className="flex flex-col gap-0.5 px-2 pb-4">
        {sortedAgents.map((agent) => {
          const threadSession = agent.threadSessionId ? sessions[agent.threadSessionId] as Session | undefined : undefined
          const lastMsg = threadSession?.messages?.at(-1)
          const isActive = currentAgentId === agent.id
          const isWorking = runningAgentIds.has(agent.id) || (threadSession?.active ?? false) || (threadSession?.heartbeatEnabled ?? false)
          const preview = lastMsg?.text?.slice(0, 80)?.replace(/\n/g, ' ') || ''

          return (
            <button
              key={agent.id}
              onClick={() => handleSelect(agent)}
              className={`w-full text-left py-3 px-3.5 rounded-[12px] cursor-pointer transition-all duration-150 border-none
                ${isActive
                  ? 'bg-accent-soft/80 border border-accent-bright/20'
                  : 'bg-transparent hover:bg-white/[0.02]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <div className="flex items-center gap-2.5">
                {/* Status dot */}
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  isWorking ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]' : 'bg-text-3/20'
                }`} />
                <span className="font-display text-[13.5px] font-600 truncate flex-1 tracking-[-0.01em]">
                  {agent.name}
                </span>
                {/* Provider badge */}
                <span className="text-[10px] text-text-3/30 font-mono shrink-0">
                  {agent.model ? agent.model.split('/').pop()?.split(':')[0] : agent.provider}
                </span>
              </div>
              {preview && (
                <div className="text-[12px] text-text-3/40 mt-1 truncate pl-[18px]">
                  {preview}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
