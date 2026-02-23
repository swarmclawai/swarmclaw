'use client'

import { useEffect, useMemo, useState } from 'react'
import { searchMemory } from '@/lib/memory'
import { useAppStore } from '@/stores/use-app-store'
import { MemoryCard } from './memory-card'
import type { MemoryEntry } from '@/types'

interface Props {
  inSidebar?: boolean
}

export function MemoryList({ inSidebar }: Props) {
  const selectedMemoryId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedMemoryId = useAppStore((s) => s.setSelectedMemoryId)
  const refreshKey = useAppStore((s) => s.memoryRefreshKey)
  const agents = useAppStore((s) => s.agents)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string>('')

  const load = async () => {
    try {
      const results = await searchMemory({ q: search || undefined })
      setEntries(Array.isArray(results) ? results : [])
    } catch {
      setEntries([])
    }
    setLoaded(true)
  }

  useEffect(() => { load() }, [refreshKey])

  useEffect(() => {
    const timer = setTimeout(load, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Derive unique agents and categories
  const uniqueAgents = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of entries) {
      const key = e.agentId || '_global'
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  }, [entries])

  const uniqueCategories = useMemo(() => {
    const cats = new Set<string>()
    for (const e of entries) cats.add(e.category || 'note')
    return Array.from(cats).sort()
  }, [entries])

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (memoryAgentFilter && (e.agentId || null) !== memoryAgentFilter) return false
      if (categoryFilter && (e.category || 'note') !== categoryFilter) return false
      return true
    })
  }, [entries, memoryAgentFilter, categoryFilter])

  const hasMultipleAgents = uniqueAgents.size > 1 || (uniqueAgents.size === 1 && !uniqueAgents.has('_global'))

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Search */}
      <div className="px-3 py-2 shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories..."
          className="w-full px-3 py-2 rounded-[10px] border border-border bg-background text-foreground
            text-[12px] outline-none transition-all duration-200 placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* Agent filter tabs */}
      {entries.length > 0 && hasMultipleAgents && (
        <div className="px-3 pb-1.5 shrink-0">
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setMemoryAgentFilter(null)}
              className={`px-2.5 py-1 rounded-[7px] text-[10px] font-600 cursor-pointer transition-all
                ${!memoryAgentFilter ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
              style={{ fontFamily: 'inherit' }}
            >
              All ({entries.length})
            </button>
            {Array.from(uniqueAgents.entries()).map(([agentId, count]) => {
              const id = agentId === '_global' ? null : agentId
              const name = id ? (agents[id]?.name || id.slice(0, 8)) : 'Global'
              return (
                <button
                  key={agentId}
                  onClick={() => setMemoryAgentFilter(id)}
                  className={`px-2.5 py-1 rounded-[7px] text-[10px] font-600 cursor-pointer transition-all truncate max-w-[120px]
                    ${memoryAgentFilter === id ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {name} ({count})
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Category filter */}
      {entries.length > 0 && uniqueCategories.length > 1 && (
        <div className="px-3 pb-1.5 shrink-0">
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setCategoryFilter('')}
              className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider
                ${!categoryFilter ? 'bg-secondary text-secondary-foreground shadow-sm' : 'bg-muted text-muted-foreground/60 hover:text-muted-foreground'}`}
              style={{ fontFamily: 'inherit' }}
            >
              all
            </button>
            {uniqueCategories.map((c) => (
              <button
                key={c}
                onClick={() => setCategoryFilter(categoryFilter === c ? '' : c)}
                className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider
                  ${categoryFilter === c ? 'bg-secondary text-secondary-foreground shadow-sm' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Memory cards */}
      {filtered.length > 0 ? (
        <div className="flex flex-col gap-0.5 px-2 pb-4">
          {filtered.map((e) => (
            <MemoryCard
              key={e.id}
              entry={e}
              active={e.id === selectedMemoryId}
              agentName={e.agentId ? (agents[e.agentId]?.name || null) : null}
              onClick={() => setSelectedMemoryId(e.id)}
            />
          ))}
        </div>
      ) : loaded ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground p-8 text-center">
          <div className="w-12 h-12 rounded-[14px] bg-muted flex items-center justify-center mb-1 border border-border">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-primary">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </div>
          <p className="font-display text-[15px] font-600 text-foreground">
            {memoryAgentFilter ? 'No memories for this agent' : 'No memories yet'}
          </p>
          <p className="text-[13px] text-muted-foreground/60">AI agents store knowledge here</p>
        </div>
      ) : null}
    </div>
  )
}
