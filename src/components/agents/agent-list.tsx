'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { AgentCard } from './agent-card'
import { TrashList } from './trash-list'
import { useApprovalStore } from '@/stores/use-approval-store'

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
  const showTrash = useAppStore((s) => s.showTrash)
  const setShowTrash = useAppStore((s) => s.setShowTrash)
  const fleetFilter = useAppStore((s) => s.fleetFilter)
  const setFleetFilter = useAppStore((s) => s.setFleetFilter)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const approvals = useApprovalStore((s) => s.approvals)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'orchestrator' | 'agent'>('all')

  // FLIP animation refs
  const flipPositions = useRef<Map<string, number>>(new Map())
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const currentSession = currentSessionId ? sessions[currentSessionId] : null
  const selectedAgentId = currentSession?.agentId

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

  // Compute which agents are "running" (have active sessions)
  const runningAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of Object.values(sessions)) {
      if (s.agentId && s.active) ids.add(s.agentId)
    }
    return ids
  }, [sessions])

  // Approval counts per agent
  const approvalsByAgent = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const a of Object.values(approvals)) {
      counts[a.agentId] = (counts[a.agentId] || 0) + 1
    }
    return counts
  }, [approvals])

  const filtered = useMemo(() => {
    return Object.values(agents)
      .filter((p) => {
        if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false
        if (filter === 'orchestrator' && !p.isOrchestrator) return false
        if (filter === 'agent' && p.isOrchestrator) return false
        if (activeProjectFilter && p.projectId !== activeProjectFilter) return false
        // Fleet filter
        if (fleetFilter === 'running' && !runningAgentIds.has(p.id)) return false
        if (fleetFilter === 'approvals' && !(approvalsByAgent[p.id] > 0)) return false
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [agents, search, filter, activeProjectFilter, fleetFilter, runningAgentIds, approvalsByAgent])

  // FLIP animation: animate agent cards when order changes
  useLayoutEffect(() => {
    const newPositions = new Map<string, number>()
    for (const [id, el] of cardRefs.current) {
      const newTop = el.getBoundingClientRect().top
      newPositions.set(id, newTop)
      const prevTop = flipPositions.current.get(id)
      if (prevTop != null) {
        const delta = prevTop - newTop
        if (Math.abs(delta) > 1) {
          el.animate(
            [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
            { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
          )
        }
      }
    }
    flipPositions.current = newPositions
  }, [filtered])

  if (showTrash) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2.5 flex items-center gap-2">
          <button
            onClick={() => setShowTrash(false)}
            className="px-3 py-1.5 rounded-[8px] text-[12px] font-600 text-text-3 bg-transparent border-none cursor-pointer hover:text-text-2 transition-all flex items-center gap-1.5"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
            </svg>
            Back to Agents
          </button>
          <span className="text-[13px] font-600 text-text-2">Trash</span>
        </div>
        <TrashList />
      </div>
    )
  }

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
    <div className="flex-1 overflow-y-auto fade-up">
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
      {/* Fleet filter: All / Running / Approvals */}
      <div className="flex gap-1 px-4 pb-1 items-center">
        {(['all', 'running', 'approvals'] as const).map((f) => {
          const count = f === 'running' ? runningAgentIds.size
            : f === 'approvals' ? Object.keys(approvalsByAgent).length
            : null
          return (
            <button
              key={f}
              onClick={() => setFleetFilter(f)}
              className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
                ${fleetFilter === f ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {f}{count ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>
      <div className="flex gap-1 px-4 pb-2 items-center">
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
        <div className="flex-1" />
        <button
          onClick={() => setShowTrash(true)}
          aria-label="View trash"
          className="p-1.5 rounded-[6px] text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-all hover:bg-white/[0.04]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col gap-1 px-2 pb-4">
        {filtered.map((p) => (
          <div key={p.id} ref={(el) => { if (el) cardRefs.current.set(p.id, el); else cardRefs.current.delete(p.id) }}>
            <AgentCard agent={p} isDefault={p.id === defaultAgentId} isRunning={runningAgentIds.has(p.id)} isSelected={p.id === selectedAgentId} onSetDefault={handleSetDefault} />
          </div>
        ))}
      </div>
    </div>
  )
}
