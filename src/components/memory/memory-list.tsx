'use client'

import { useEffect, useState } from 'react'
import { searchMemory } from '@/lib/memory'
import { useAppStore } from '@/stores/use-app-store'
import { MemoryCard } from './memory-card'
import type { MemoryEntry } from '@/types'

interface Props {
  inSidebar?: boolean
}

export function MemoryList({ inSidebar }: Props) {
  const setMemorySheetOpen = useAppStore((s) => s.setMemorySheetOpen)
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    try {
      const results = await searchMemory(search || undefined)
      setEntries(Array.isArray(results) ? results : [])
    } catch {
      setEntries([])
    }
    setLoaded(true)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const timer = setTimeout(load, 300)
    return () => clearTimeout(timer)
  }, [search])

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      <div className="px-4 py-2.5 shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories..."
          className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.04] bg-surface text-text
            text-[13px] outline-none transition-all duration-200 placeholder:text-text-3/40 focus-glow"
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {entries.length > 0 ? (
        <div className="flex flex-col gap-1 px-2 pb-4">
          {entries.map((e) => (
            <MemoryCard key={e.id} entry={e} onUpdate={load} />
          ))}
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
          <p className="font-display text-[15px] font-600 text-text-2">No memories yet</p>
          <p className="text-[13px] text-text-3/50">AI agents store knowledge here</p>
        </div>
      ) : null}
    </div>
  )
}
