'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { searchMemory } from '@/lib/memory'
import { useAppStore } from '@/stores/use-app-store'
import { MemoryCard } from './memory-card'
import { MemoryDetail } from './memory-detail'
import { MemoryGraphView } from './memory-graph-view'
import type { MemoryEntry } from '@/types'

export function MemoryBrowser() {
  const selectedMemoryId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedMemoryId = useAppStore((s) => s.setSelectedMemoryId)
  const refreshKey = useAppStore((s) => s.memoryRefreshKey)
  const agents = useAppStore((s) => s.agents)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)

  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list')
  const searchRef = useRef(search)

  // Derive the API agentId from the filter
  const apiAgentId = useMemo(() => {
    if (!memoryAgentFilter) return undefined // all
    if (memoryAgentFilter === '_global') return undefined // we'll filter client-side
    return memoryAgentFilter
  }, [memoryAgentFilter])

  const load = useCallback(async (query: string) => {
    try {
      const results = await searchMemory({ q: query || undefined, agentId: apiAgentId })
      setEntries(Array.isArray(results) ? results : [])
      setError(null)
    } catch {
      setError('Unable to load memories right now.')
    }
    setLoaded(true)
  }, [apiAgentId])

  useEffect(() => {
    searchRef.current = search
  }, [search])

  useEffect(() => {
    const timer = setTimeout(() => { void load(searchRef.current) }, 0)
    return () => clearTimeout(timer)
  }, [refreshKey, load])

  useEffect(() => {
    const timer = setTimeout(() => { void load(search) }, 300)
    return () => clearTimeout(timer)
  }, [search, load])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedMemoryId(null)
    setCategoryFilter('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryAgentFilter])

  const uniqueCategories = useMemo(() => {
    const cats = new Set<string>()
    for (const e of entries) cats.add(e.category || 'note')
    return Array.from(cats).sort()
  }, [entries])

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      // Client-side global filter
      if (memoryAgentFilter === '_global' && e.agentId) return false
      if (categoryFilter && (e.category || 'note') !== categoryFilter) return false
      return true
    })
  }, [entries, memoryAgentFilter, categoryFilter])

  const filterLabel = useMemo(() => {
    if (!memoryAgentFilter) return 'All Memories'
    if (memoryAgentFilter === '_global') return 'Global Memories'
    return agents[memoryAgentFilter]?.name || 'Agent'
  }, [memoryAgentFilter, agents])

  // No agent selected prompt
  if (!memoryAgentFilter && !loaded && entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-[380px]">
          <div className="w-14 h-14 rounded-[16px] bg-white/[0.03] flex items-center justify-center mb-4 mx-auto">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/60">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </div>
          <h2 className="font-display text-[15px] font-600 text-text-2 mb-2">Browse Memories</h2>
          <p className="text-[13px] text-text-3/70">Select an agent from the sidebar to browse their memories, or view all.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex h-full min-w-0">
      {/* Left: Memory card list or Graph Toggle */}
      <div className="w-[360px] shrink-0 border-r border-white/[0.06] flex flex-col overflow-hidden">
        {/* Header + search */}
        <div className="px-3 pt-3 pb-1 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-display text-[13px] font-600 text-text-2 tracking-[-0.01em] flex-1 truncate">{filterLabel}</h3>
            <div className="flex bg-white/[0.04] p-0.5 rounded-[8px]">
               <button 
                 onClick={() => setViewMode('list')}
                 className={`p-1 rounded-[6px] transition-colors ${viewMode === 'list' ? 'bg-white/[0.08] text-text' : 'text-text-3 hover:text-text-2'}`}
               >
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
               </button>
               <button 
                 onClick={() => setViewMode('graph')}
                 className={`p-1 rounded-[6px] transition-colors ${viewMode === 'graph' ? 'bg-white/[0.08] text-text' : 'text-text-3 hover:text-text-2'}`}
               >
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
               </button>
            </div>
            <span className="text-[10px] font-mono tabular-nums text-text-3/50">{filtered.length}</span>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories..."
            className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
              text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        {/* Category chips */}
        {entries.length > 0 && uniqueCategories.length > 1 && (
          <div className="px-3 py-1.5 shrink-0">
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => setCategoryFilter('')}
                className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border-none
                  ${!categoryFilter ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'}`}
                style={{ fontFamily: 'inherit' }}
              >
                all
              </button>
              {uniqueCategories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategoryFilter(categoryFilter === c ? '' : c)}
                  className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border-none
                    ${categoryFilter === c ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Cards */}
        <div className="flex-1 overflow-y-auto">
          {viewMode === 'list' ? (
            filtered.length > 0 ? (
              <div className="flex flex-col gap-0.5 px-2 pb-4">
                {filtered.map((e) => {
                  // Show agent info on cards when in "All Memories" view
                  const showAgent = !memoryAgentFilter
                  const agent = showAgent && e.agentId ? agents[e.agentId] : null
                  return (
                    <MemoryCard
                      key={e.id}
                      entry={e}
                      active={e.id === selectedMemoryId}
                      agentName={showAgent ? (agent?.name || null) : undefined}
                      agentAvatarSeed={showAgent ? (agent?.avatarSeed || null) : undefined}
                      agentAvatarUrl={showAgent ? (agent?.avatarUrl || null) : undefined}
                      onClick={() => setSelectedMemoryId(e.id)}
                    />
                  )
                })}
              </div>
            ) : error ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center">
                <p className="font-display text-[14px] font-600 text-text-2">Couldn&apos;t load memories</p>
                <p className="text-[12px] text-text-3/60">{error}</p>
                <button
                  onClick={() => { void load(search) }}
                  className="px-3 py-1.5 rounded-[8px] bg-accent-soft text-accent-bright text-[12px] font-600 cursor-pointer border-none"
                  style={{ fontFamily: 'inherit' }}
                >
                  Retry
                </button>
              </div>
            ) : loaded ? (
              <div className="flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center">
                <div className="w-10 h-10 rounded-[12px] bg-accent-soft flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
                    <ellipse cx="12" cy="5" rx="9" ry="3" />
                    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                  </svg>
                </div>
                <p className="font-display text-[14px] font-600 text-text-2">No memories yet</p>
                <p className="text-[12px] text-text-3/50">Agents store knowledge here as they learn</p>
              </div>
            ) : null
          ) : (
            <div className="p-4 text-[12px] text-text-3 italic">
              Graph view enabled in main area.
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail or Graph */}
      <div className="flex-1 flex flex-col min-w-0">
        {viewMode === 'graph' ? (
          <div className="flex-1 p-4 flex flex-col">
            <MemoryGraphView />
          </div>
        ) : (
          <MemoryDetail />
        )}
      </div>
    </div>
  )
}
