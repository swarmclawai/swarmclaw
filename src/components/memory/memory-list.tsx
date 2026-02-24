'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { searchMemory } from '@/lib/memory'
import { useAppStore } from '@/stores/use-app-store'
import { MemoryCard } from './memory-card'
import type { MemoryEntry } from '@/types'

interface Props {
  inSidebar?: boolean
  onSelect?: () => void
}

export function MemoryList({ inSidebar: _inSidebar, onSelect }: Props) {
  void _inSidebar
  const selectedMemoryId = useAppStore((s) => s.selectedMemoryId)
  const setSelectedMemoryId = useAppStore((s) => s.setSelectedMemoryId)
  const refreshKey = useAppStore((s) => s.memoryRefreshKey)
  const agents = useAppStore((s) => s.agents)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const searchRef = useRef(search)

  const load = useCallback(async (query: string) => {
    try {
      const results = await searchMemory({ q: query || undefined })
      setEntries(Array.isArray(results) ? results : [])
      setError(null)
    } catch {
      setError('Unable to load memories right now.')
    }
    setLoaded(true)
  }, [])

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
          className="w-full px-3 py-2 rounded-[10px] border border-white/[0.04] bg-surface text-text
            text-[12px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow"
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
                ${!memoryAgentFilter ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
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
                    ${memoryAgentFilter === id ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
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
                ${!categoryFilter ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'}`}
              style={{ fontFamily: 'inherit' }}
            >
              all
            </button>
            {uniqueCategories.map((c) => (
              <button
                key={c}
                onClick={() => setCategoryFilter(categoryFilter === c ? '' : c)}
                className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider
                  ${categoryFilter === c ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'}`}
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
              onClick={() => {
                setSelectedMemoryId(e.id)
                onSelect?.()
              }}
            />
          ))}
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
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
          <div className="w-12 h-12 rounded-[14px] bg-accent-soft flex items-center justify-center mb-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </div>
          <p className="font-display text-[15px] font-600 text-text-2">
            {memoryAgentFilter ? 'No memories for this agent' : 'No memories yet'}
          </p>
          <p className="text-[13px] text-text-3/50">AI agents store knowledge here</p>
        </div>
      ) : null}
    </div>
  )
}
