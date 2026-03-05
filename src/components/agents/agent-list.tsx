'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentCard } from './agent-card'
import { TrashList } from './trash-list'
import { useApprovalStore } from '@/stores/use-approval-store'
import { Skeleton } from '@/components/shared/skeleton'
import { EmptyState } from '@/components/shared/empty-state'

interface Props {
  inSidebar?: boolean
}

export function AgentList({ inSidebar }: Props) {
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const sessions = useAppStore((s) => s.sessions)
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

  const appSettings = useAppStore((s) => s.appSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const defaultAgentId = (appSettings.defaultAgentId && agents[appSettings.defaultAgentId])
    ? appSettings.defaultAgentId
    : Object.values(agents)[0]?.id || 'default'

  const handleSetDefault = useCallback(async (agentId: string) => {
    try {
      await updateSettings({ defaultAgentId: agentId })
    } catch { /* ignore */ }
  }, [updateSettings])

  const [loaded, setLoaded] = useState(Object.keys(agents).length > 0)
  useEffect(() => { loadAgents().then(() => setLoaded(true)) }, [])

  // Compute which agents are "running" (have active sessions)
  const runningAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of Object.values(sessions)) {
      if (s.agentId && s.active) ids.add(s.agentId)
    }
    return ids
  }, [sessions])

  // Re-evaluate online status periodically (Date.now() can't be called in useMemo directly)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Agents that are "online": heartbeat enabled + tools, or recently active (within 30min)
  const onlineAgentIds = useMemo(() => {
    const ids = new Set<string>()
    const recentThreshold = now - 30 * 60 * 1000
    for (const a of Object.values(agents)) {
      if (a.heartbeatEnabled === true && (a.plugins?.length ?? 0) > 0) { ids.add(a.id); continue }
      // Check if any session for this agent was active in the last 30 minutes
      for (const s of Object.values(sessions)) {
        if (s.agentId === a.id && (s.lastActiveAt ?? 0) > recentThreshold) { ids.add(a.id); break }
      }
    }
    return ids
  }, [agents, sessions, now])

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
    // Show skeleton cards while loading
    if (!loaded) {
      return (
        <div className="flex-1 flex flex-col gap-1 px-2 pt-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="py-3.5 px-4 rounded-[14px] border border-transparent">
              <div className="flex items-center gap-2.5">
                <Skeleton className="rounded-full" width={28} height={28} />
                <Skeleton className="rounded-[6px]" width={120} height={14} />
              </div>
              <Skeleton className="rounded-[6px] mt-2" width="80%" height={12} />
              <Skeleton className="rounded-[6px] mt-1.5" width={80} height={11} />
            </div>
          ))}
        </div>
      )
    }
    return (
      <EmptyState
        icon={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        }
        title="No agents yet"
        subtitle="Create AI agents and orchestrators"
        action={!inSidebar ? { label: '+ New Agent', onClick: () => setAgentSheetOpen(true) } : undefined}
      />
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
            <AgentCard agent={p} isDefault={p.id === defaultAgentId} isRunning={runningAgentIds.has(p.id)} isOnline={onlineAgentIds.has(p.id)} isSelected={p.id === selectedAgentId} onSetDefault={handleSetDefault} />
          </div>
        ))}
      </div>
    </div>
  )
}
