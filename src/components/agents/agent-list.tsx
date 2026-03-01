'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { AgentCard } from './agent-card'

interface Props {
  inSidebar?: boolean
}

export function AgentList({ inSidebar }: Props) {
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const sessions = useAppStore((s) => s.sessions)
  const currentUser = useAppStore((s) => s.currentUser)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'orchestrator' | 'agent'>('all')

  const mainSession = useMemo(() =>
    Object.values(sessions).find((s: any) => s.name === '__main__' && s.user === currentUser),
    [sessions, currentUser]
  )
  const defaultAgentId = mainSession?.agentId || 'default'

  const handleSetDefault = useCallback(async (agentId: string) => {
    if (!mainSession) return
    try {
      await api('PUT', `/sessions/${mainSession.id}`, { agentId })
      await loadSessions()
    } catch { /* ignore */ }
  }, [mainSession, loadSessions])

  useEffect(() => { loadAgents() }, [])

  const filtered = useMemo(() => {
    return Object.values(agents)
      .filter((p) => {
        if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false
        if (filter === 'orchestrator' && !p.isOrchestrator) return false
        if (filter === 'agent' && p.isOrchestrator) return false
        if (activeProjectFilter && p.projectId !== activeProjectFilter) return false
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [agents, search, filter, activeProjectFilter])

  if (!filtered.length && !search) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-accent-soft flex items-center justify-center mb-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
        <p className="font-display text-[15px] font-600 text-text-2">No agents yet</p>
        <p className="text-[13px] text-text-3/50">Create AI agents and orchestrators</p>
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
      {(filtered.length > 3 || search) && (
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
      <div className="flex gap-1 px-4 pb-2">
        {(['all', 'orchestrator', 'agent'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
              ${filter === f ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1 px-2 pb-4">
        {filtered.map((p) => (
          <AgentCard key={p.id} agent={p} isDefault={p.id === defaultAgentId} onSetDefault={handleSetDefault} />
        ))}
      </div>
    </div>
  )
}
