'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { Badge } from '@/components/ui/badge'
import type { MemoryEntry } from '@/types'

export function KnowledgeList() {
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchRef = useRef(search)
  const setKnowledgeSheetOpen = useAppStore((s) => s.setKnowledgeSheetOpen)
  const setEditingKnowledgeId = useAppStore((s) => s.setEditingKnowledgeId)

  const openSheet = useCallback((id?: string) => {
    setEditingKnowledgeId(id ?? null)
    setKnowledgeSheetOpen(true)
  }, [setEditingKnowledgeId, setKnowledgeSheetOpen])

  const load = useCallback(async (query: string, tag?: string | null) => {
    try {
      const params = new URLSearchParams()
      if (query) params.set('q', query)
      if (tag) params.set('tags', tag)
      const qs = params.toString()
      const results = await api<MemoryEntry[]>('GET', `/knowledge${qs ? `?${qs}` : ''}`)
      setEntries(Array.isArray(results) ? results : [])
      setError(null)
    } catch {
      setError('Unable to load knowledge entries.')
    }
    setLoaded(true)
  }, [])

  useEffect(() => { searchRef.current = search }, [search])

  // Initial load
  useEffect(() => {
    const timer = setTimeout(() => { void load(searchRef.current, activeTag) }, 0)
    return () => clearTimeout(timer)
  }, [load, activeTag])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => { void load(search, activeTag) }, 300)
    return () => clearTimeout(timer)
  }, [search, load, activeTag])

  const uniqueTags = useMemo(() => {
    const tags = new Set<string>()
    for (const e of entries) {
      const meta = e.metadata as { tags?: string[] } | undefined
      if (meta?.tags) for (const t of meta.tags) tags.add(t)
    }
    return Array.from(tags).sort()
  }, [entries])

  const handleDelete = async (id: string) => {
    try {
      await api('DELETE', `/knowledge/${id}`)
      setEntries((prev) => prev.filter((e) => e.id !== id))
      if (selectedId === id) setSelectedId(null)
    } catch {
      // silent
    }
  }

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Search — only show when there are entries */}
      {entries.length > 0 && (
        <div className="px-3 py-2 shrink-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search knowledge..."
            className="w-full px-3 py-2 rounded-[10px] border border-white/[0.04] bg-surface text-text
              text-[12px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}

      {/* Tag filters */}
      {uniqueTags.length > 0 && (
        <div className="px-3 pb-1.5 shrink-0">
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider
                ${!activeTag ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'}`}
              style={{ fontFamily: 'inherit' }}
            >
              all
            </button>
            {uniqueTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider
                  ${activeTag === tag ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Entries */}
      {entries.length > 0 ? (
        <div className="flex flex-col gap-0.5 px-2 pb-4">
          {entries.map((entry) => {
            const meta = entry.metadata as { tags?: string[] } | undefined
            const tags = meta?.tags || []
            return (
              <div
                key={entry.id}
                onClick={() => setSelectedId(selectedId === entry.id ? null : entry.id)}
                className={`p-3 rounded-[12px] border cursor-pointer transition-all
                  ${selectedId === entry.id
                    ? 'border-accent-bright/30 bg-accent-soft/30'
                    : 'border-white/[0.04] bg-transparent hover:bg-surface-2'
                  }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="font-display text-[13px] font-600 text-text truncate">{entry.title}</span>
                  <span className="text-[10px] text-text-3/50 shrink-0">{formatDate(entry.createdAt)}</span>
                </div>
                <p className="text-[11px] text-text-3/60 line-clamp-2 mb-2">
                  {entry.content.slice(0, 200)}
                </p>
                {tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap mb-2">
                    {tags.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[9px] px-1.5 py-0">{t}</Badge>
                    ))}
                  </div>
                )}
                {selectedId === entry.id && (
                  <div className="flex gap-2 pt-2 border-t border-white/[0.04]">
                    <button
                      onClick={(e) => { e.stopPropagation(); openSheet(entry.id) }}
                      className="px-2.5 py-1 rounded-[7px] text-[10px] font-600 text-accent-bright bg-accent-soft cursor-pointer border-none hover:brightness-110 transition-all"
                      style={{ fontFamily: 'inherit' }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleDelete(entry.id) }}
                      className="px-2.5 py-1 rounded-[7px] text-[10px] font-600 text-red-400 bg-red-400/10 cursor-pointer border-none hover:bg-red-400/20 transition-all"
                      style={{ fontFamily: 'inherit' }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center">
          <p className="font-display text-[14px] font-600 text-text-2">Couldn&apos;t load knowledge</p>
          <p className="text-[12px] text-text-3/60">{error}</p>
          <button
            onClick={() => { void load(search, activeTag) }}
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
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <p className="font-display text-[15px] font-600 text-text-2">No knowledge entries yet</p>
          <p className="text-[13px] text-text-3/50">Add shared knowledge for your agents</p>
          <button
            onClick={() => openSheet()}
            className="mt-1 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            + Add Knowledge
          </button>
        </div>
      ) : null}
    </div>
  )
}
