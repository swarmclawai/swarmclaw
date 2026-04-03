'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { Badge } from '@/components/ui/badge'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { PageLoader } from '@/components/ui/page-loader'
import { SearchInput } from '@/components/ui/search-input'
import type { KnowledgeHygieneSummary, KnowledgeSearchHit, KnowledgeSourceSummary } from '@/types'
import { toast } from 'sonner'

export function KnowledgeList() {
  const [search, setSearch] = useState('')
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([])
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [hygiene, setHygiene] = useState<KnowledgeHygieneSummary | null>(null)
  const [maintaining, setMaintaining] = useState(false)
  const searchRef = useRef(search)

  const agents = useAppStore((state) => state.agents)
  const loadAgents = useAppStore((state) => state.loadAgents)
  const refreshKey = useAppStore((state) => state.knowledgeRefreshKey)
  const openKnowledgeSheet = useAppStore((state) => state.setKnowledgeSheetOpen)
  const setEditingKnowledgeId = useAppStore((state) => state.setEditingKnowledgeId)
  const selectedKnowledgeSourceId = useAppStore((state) => state.selectedKnowledgeSourceId)
  const setSelectedKnowledgeSourceId = useAppStore((state) => state.setSelectedKnowledgeSourceId)
  const triggerKnowledgeRefresh = useAppStore((state) => state.triggerKnowledgeRefresh)

  const openSheet = useCallback((id?: string) => {
    setEditingKnowledgeId(id ?? null)
    openKnowledgeSheet(true)
  }, [openKnowledgeSheet, setEditingKnowledgeId])

  const load = useCallback(async (query: string, tag?: string | null) => {
    try {
      const params = new URLSearchParams()
      if (tag) params.set('tags', tag)
      if (includeArchived) params.set('includeArchived', 'true')
      const currentSelectedId = useAppStore.getState().selectedKnowledgeSourceId

      if (query.trim()) {
        params.set('q', query.trim())
        const results = await api<KnowledgeSearchHit[]>('GET', `/knowledge?${params.toString()}`)
        const nextHits = Array.isArray(results) ? results : []
        setHits(nextHits)
        setSources([])
        if (!currentSelectedId || !nextHits.some((hit) => hit.sourceId === currentSelectedId)) {
          setSelectedKnowledgeSourceId(nextHits[0]?.sourceId || null)
        }
      } else {
        const qs = params.toString()
        const results = await api<KnowledgeSourceSummary[]>('GET', `/knowledge/sources${qs ? `?${qs}` : ''}`)
        const nextSources = Array.isArray(results) ? results : []
        setSources(nextSources)
        setHits([])
        if (!currentSelectedId || !nextSources.some((source) => source.id === currentSelectedId)) {
          setSelectedKnowledgeSourceId(nextSources[0]?.id || null)
        }
      }
      setError(null)
    } catch {
      setError('Unable to load knowledge sources.')
    }
    setLoaded(true)
  }, [includeArchived, setSelectedKnowledgeSourceId])

  const loadHygiene = useCallback(async () => {
    try {
      const summary = await api<KnowledgeHygieneSummary>('GET', '/knowledge/hygiene')
      setHygiene(summary)
    } catch {
      setHygiene(null)
    }
  }, [])

  useEffect(() => {
    searchRef.current = search
  }, [search])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    const timer = setTimeout(() => {
      void load(searchRef.current, activeTag)
    }, 0)
    return () => clearTimeout(timer)
  }, [activeTag, load, refreshKey])

  useEffect(() => {
    void loadHygiene()
  }, [loadHygiene, refreshKey])

  useEffect(() => {
    const timer = setTimeout(() => {
      void load(search, activeTag)
    }, 250)
    return () => clearTimeout(timer)
  }, [activeTag, includeArchived, load, search])

  const uniqueTags = useMemo(() => {
    const tags = new Set<string>()
    const items = search.trim() ? hits : sources
    for (const item of items) {
      for (const tag of item.tags) tags.add(tag)
    }
    return Array.from(tags).sort((left, right) => left.localeCompare(right))
  }, [hits, search, sources])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api('DELETE', `/knowledge/sources/${id}`)
      if (selectedKnowledgeSourceId === id) {
        setSelectedKnowledgeSourceId(null)
      }
      triggerKnowledgeRefresh()
    } catch {
      // Best-effort delete; caller can retry from refreshed list.
    }
  }, [selectedKnowledgeSourceId, setSelectedKnowledgeSourceId, triggerKnowledgeRefresh])

  const runMaintenance = useCallback(async () => {
    setMaintaining(true)
    try {
      await api('POST', '/knowledge/hygiene')
      triggerKnowledgeRefresh()
      void loadHygiene()
      toast.success('Knowledge maintenance completed')
    } catch {
      toast.error('Knowledge maintenance failed')
    } finally {
      setMaintaining(false)
    }
  }, [loadHygiene, triggerKnowledgeRefresh])

  const formatDate = (timestamp?: number | null) => {
    if (!timestamp) return 'Not indexed'
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const scopedAgentsFor = (agentIds: string[]) => agentIds.map((id) => agents[id]).filter(Boolean)

  if (!loaded) {
    return <PageLoader label="Loading knowledge..." />
  }

  const showingHits = search.trim().length > 0
  const items = showingHits ? hits : sources

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      <div className="px-5 py-2 shrink-0" style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
        <SearchInput
          size="sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch('')}
          placeholder="Search knowledge..."
        />
      </div>

      {hygiene && (
        <div className="px-5 pb-2 shrink-0">
          <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/55">Hygiene</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-text-2/80">
                  <span>stale {hygiene.counts.stale}</span>
                  <span>duplicates {hygiene.counts.duplicate}</span>
                  <span>broken {hygiene.counts.broken}</span>
                  <span>archived {hygiene.counts.archived}</span>
                  <span>superseded {hygiene.counts.superseded}</span>
                </div>
              </div>
              <button
                onClick={() => { void runMaintenance() }}
                disabled={maintaining}
                className="rounded-[9px] border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-600 text-text-2 transition-all cursor-pointer disabled:opacity-50"
              >
                {maintaining ? 'Running…' : 'Maintain'}
              </button>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="text-[10px] text-text-3/55">
                Last scan {new Date(hygiene.scannedAt).toLocaleTimeString()}
              </div>
              <button
                onClick={() => setIncludeArchived((current) => !current)}
                className={`rounded-[8px] px-2 py-1 text-[10px] font-700 uppercase tracking-[0.08em] cursor-pointer ${
                  includeArchived ? 'bg-amber-500/12 text-amber-200' : 'bg-white/[0.04] text-text-3/75'
                }`}
              >
                {includeArchived ? 'Showing archived' : 'Hide archived'}
              </button>
            </div>
          </div>
        </div>
      )}

      {uniqueTags.length > 0 && (
        <div className="px-5 pb-1.5 shrink-0" style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.05s both' }}>
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider ${
                !activeTag ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'
              }`}
              style={{ fontFamily: 'inherit' }}
            >
              all
            </button>
            {uniqueTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-2 py-0.5 rounded-[6px] text-[9px] font-600 cursor-pointer transition-all uppercase tracking-wider ${
                  activeTag === tag ? 'bg-white/[0.06] text-text-2' : 'bg-transparent text-text-3/70 hover:text-text-3'
                }`}
                style={{ fontFamily: 'inherit' }}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {items.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 px-5 pb-6">
          {showingHits
            ? hits.map((hit, idx) => {
                const scopedAgents = scopedAgentsFor(hit.agentIds)
                const active = selectedKnowledgeSourceId === hit.sourceId
                return (
                  <div
                    key={hit.id}
                    onClick={() => setSelectedKnowledgeSourceId(hit.sourceId)}
                    className={`p-3 rounded-[12px] border transition-all relative group cursor-pointer ${
                      active
                        ? 'border-accent-bright/25 bg-accent-soft/10'
                        : 'border-white/[0.04] bg-transparent hover:bg-surface-2 hover:border-white/[0.1]'
                    }`}
                    style={{
                      animation: 'spring-in 0.5s var(--ease-spring) both',
                      animationDelay: `${0.08 + idx * 0.02}s`,
                    }}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="font-display text-[13px] font-600 text-text truncate">{hit.sourceTitle}</span>
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 uppercase">{hit.sourceKind}</Badge>
                        </div>
                        <p className="text-[10px] text-text-3/55">
                          Chunk {hit.chunkIndex + 1} of {hit.chunkCount}
                          {hit.sectionLabel ? ` • ${hit.sectionLabel}` : ''}
                        </p>
                        {hit.whyMatched && (
                          <p className="mt-1 text-[10px] text-sky-200/70">{hit.whyMatched}</p>
                        )}
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          openSheet(hit.sourceId)
                        }}
                        className="text-text-3/40 hover:text-accent-bright transition-colors p-0.5 cursor-pointer"
                        title="Edit"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    </div>

                    <p className="text-[11px] text-text-2/80 line-clamp-4">{hit.snippet}</p>

                    <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                      {hit.tags.map((tag) => (
                        <Badge key={`${hit.id}-${tag}`} variant="secondary" className="text-[9px] px-1.5 py-0">{tag}</Badge>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 mt-2.5">
                      <span className={`text-[10px] font-600 ${hit.scope === 'global' ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {hit.scope === 'global' ? 'Global' : `${hit.agentIds.length} agent(s)`}
                      </span>
                      {scopedAgents.length > 0 && (
                        <div className="flex items-center -space-x-1.5">
                          {scopedAgents.slice(0, 5).map((agent) => (
                            <AgentAvatar
                              key={agent.id}
                              seed={agent.avatarSeed}
                              avatarUrl={agent.avatarUrl}
                              name={agent.name}
                              size={16}
                              className="ring-1 ring-surface"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            : sources.map((source, idx) => {
                const scopedAgents = scopedAgentsFor(source.agentIds)
                const active = selectedKnowledgeSourceId === source.id
                return (
                  <div
                    key={source.id}
                    onClick={() => setSelectedKnowledgeSourceId(source.id)}
                    className={`p-3 rounded-[12px] border transition-all relative group cursor-pointer ${
                      active
                        ? 'border-accent-bright/25 bg-accent-soft/10'
                        : 'border-white/[0.04] bg-transparent hover:bg-surface-2 hover:border-white/[0.1]'
                    }`}
                    style={{
                      animation: 'spring-in 0.5s var(--ease-spring) both',
                      animationDelay: `${0.08 + idx * 0.02}s`,
                    }}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="font-display text-[13px] font-600 text-text truncate">{source.title}</span>
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 uppercase">{source.kind}</Badge>
                          {source.archivedAt ? (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 uppercase text-amber-200">archived</Badge>
                          ) : source.supersededBySourceId ? (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 uppercase text-text-3">superseded</Badge>
                          ) : null}
                        </div>
                        <p className="text-[10px] text-text-3/55">
                          {source.chunkCount} chunk{source.chunkCount === 1 ? '' : 's'}
                          {' • '}
                          {formatDate(source.lastIndexedAt)}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(event) => {
                            event.stopPropagation()
                            openSheet(source.id)
                          }}
                          className="text-text-3/40 hover:text-accent-bright transition-colors p-0.5 cursor-pointer"
                          title="Edit"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleDelete(source.id)
                          }}
                          className="text-text-3/40 hover:text-red-400 transition-colors p-0.5 cursor-pointer"
                          title="Delete"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {source.topSnippet && (
                      <p className="text-[11px] text-text-3/70 line-clamp-3 mb-2">{source.topSnippet}</p>
                    )}

                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-600 ${
                        source.syncStatus === 'error'
                          ? 'text-red-300'
                          : source.stale
                            ? 'text-amber-300'
                            : 'text-emerald-300'
                      }`}
                      >
                        {source.syncStatus === 'error' ? 'Sync error' : source.stale ? 'Stale' : 'Ready'}
                      </span>
                      <span className={`text-[10px] font-600 ${source.scope === 'global' ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {source.scope === 'global' ? 'Global' : `${source.agentIds.length} agent(s)`}
                      </span>
                      {source.sourceLabel && (
                        <span className="text-[10px] text-text-3/55 truncate">{source.sourceLabel}</span>
                      )}
                    </div>

                    {source.tags.length > 0 && (
                      <div className="flex items-center gap-1 mt-2 flex-wrap">
                        {source.tags.map((tag) => (
                          <Badge key={`${source.id}-${tag}`} variant="secondary" className="text-[9px] px-1.5 py-0">{tag}</Badge>
                        ))}
                      </div>
                    )}

                    {scopedAgents.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <div className="flex items-center -space-x-1.5">
                          {scopedAgents.slice(0, 5).map((agent) => (
                            <AgentAvatar
                              key={agent.id}
                              seed={agent.avatarSeed}
                              avatarUrl={agent.avatarUrl}
                              name={agent.name}
                              size={16}
                              className="ring-1 ring-surface"
                            />
                          ))}
                        </div>
                        {scopedAgents.length > 5 && (
                          <span className="text-[10px] font-600 text-text-3/60">+{scopedAgents.length - 5}</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
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
      ) : (
        <EmptyState
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          }
          title={showingHits ? 'No matching knowledge chunks' : 'No knowledge sources yet'}
          subtitle={showingHits ? 'Try a broader query or clear filters' : 'Add a manual note, upload a file, or import a URL'}
          action={{ label: '+ Add Knowledge', onClick: () => openSheet() }}
        />
      )}
    </div>
  )
}
