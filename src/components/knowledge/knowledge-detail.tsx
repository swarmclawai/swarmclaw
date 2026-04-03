'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { EmptyState } from '@/components/shared/empty-state'
import { PageLoader } from '@/components/ui/page-loader'
import { Badge } from '@/components/ui/badge'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { KnowledgeSourceDetail } from '@/types'
import { toast } from 'sonner'

export function KnowledgeDetail() {
  const selectedKnowledgeSourceId = useAppStore((state) => state.selectedKnowledgeSourceId)
  const setSelectedKnowledgeSourceId = useAppStore((state) => state.setSelectedKnowledgeSourceId)
  const setEditingKnowledgeId = useAppStore((state) => state.setEditingKnowledgeId)
  const setKnowledgeSheetOpen = useAppStore((state) => state.setKnowledgeSheetOpen)
  const refreshKey = useAppStore((state) => state.knowledgeRefreshKey)
  const triggerKnowledgeRefresh = useAppStore((state) => state.triggerKnowledgeRefresh)
  const agents = useAppStore((state) => state.agents)
  const loadAgents = useAppStore((state) => state.loadAgents)

  const [detail, setDetail] = useState<KnowledgeSourceDetail | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [supersedeTargetId, setSupersedeTargetId] = useState('')

  const loadDetail = useCallback(async (id: string) => {
    try {
      const nextDetail = await api<KnowledgeSourceDetail>('GET', `/knowledge/sources/${id}`)
      setDetail(nextDetail)
      setSupersedeTargetId('')
      setError(null)
    } catch {
      setDetail(null)
      setError('Unable to load this knowledge source.')
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    if (!selectedKnowledgeSourceId) {
      setDetail(null)
      setError(null)
      setSupersedeTargetId('')
      setLoaded(true)
      return
    }
    setLoaded(false)
    void loadDetail(selectedKnowledgeSourceId)
  }, [loadDetail, refreshKey, selectedKnowledgeSourceId])

  const openEdit = useCallback(() => {
    if (!selectedKnowledgeSourceId) return
    setEditingKnowledgeId(selectedKnowledgeSourceId)
    setKnowledgeSheetOpen(true)
  }, [selectedKnowledgeSourceId, setEditingKnowledgeId, setKnowledgeSheetOpen])

  const handleSync = useCallback(async () => {
    if (!selectedKnowledgeSourceId) return
    setSyncing(true)
    try {
      const nextDetail = await api<KnowledgeSourceDetail>('POST', `/knowledge/sources/${selectedKnowledgeSourceId}/sync`)
      setDetail(nextDetail)
      triggerKnowledgeRefresh()
      toast.success('Knowledge source synced')
    } catch (syncError) {
      toast.error(syncError instanceof Error ? syncError.message : 'Knowledge sync failed')
    } finally {
      setSyncing(false)
    }
  }, [selectedKnowledgeSourceId, triggerKnowledgeRefresh])

  const handleDelete = useCallback(async () => {
    if (!selectedKnowledgeSourceId) return
    setDeleting(true)
    try {
      await api('DELETE', `/knowledge/sources/${selectedKnowledgeSourceId}`)
      setSelectedKnowledgeSourceId(null)
      triggerKnowledgeRefresh()
      toast.success('Knowledge source deleted')
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : 'Failed to delete knowledge source')
    } finally {
      setDeleting(false)
    }
  }, [selectedKnowledgeSourceId, setSelectedKnowledgeSourceId, triggerKnowledgeRefresh])

  const handleArchive = useCallback(async () => {
    if (!selectedKnowledgeSourceId) return
    setArchiving(true)
    try {
      const nextDetail = await api<KnowledgeSourceDetail>('POST', `/knowledge/sources/${selectedKnowledgeSourceId}/archive`, {
        reason: 'manual',
      })
      setDetail(nextDetail)
      triggerKnowledgeRefresh()
      toast.success('Knowledge source archived')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to archive knowledge source')
    } finally {
      setArchiving(false)
    }
  }, [selectedKnowledgeSourceId, triggerKnowledgeRefresh])

  const handleRestore = useCallback(async () => {
    if (!selectedKnowledgeSourceId) return
    setRestoring(true)
    try {
      const nextDetail = await api<KnowledgeSourceDetail>('POST', `/knowledge/sources/${selectedKnowledgeSourceId}/restore`)
      setDetail(nextDetail)
      triggerKnowledgeRefresh()
      toast.success('Knowledge source restored')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore knowledge source')
    } finally {
      setRestoring(false)
    }
  }, [selectedKnowledgeSourceId, triggerKnowledgeRefresh])

  const handleSupersede = useCallback(async () => {
    if (!selectedKnowledgeSourceId || !supersedeTargetId.trim()) return
    try {
      const nextDetail = await api<KnowledgeSourceDetail>('POST', `/knowledge/sources/${selectedKnowledgeSourceId}/supersede`, {
        supersededBySourceId: supersedeTargetId.trim(),
      })
      setDetail(nextDetail)
      setSupersedeTargetId('')
      triggerKnowledgeRefresh()
      toast.success('Knowledge source marked as superseded')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to supersede knowledge source')
    }
  }, [selectedKnowledgeSourceId, supersedeTargetId, triggerKnowledgeRefresh])

  const formatDateTime = (timestamp?: number | null) => {
    if (!timestamp) return 'Not available'
    return new Date(timestamp).toLocaleString()
  }

  if (!selectedKnowledgeSourceId) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <EmptyState
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-accent-bright">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          }
          title="Select Knowledge"
          subtitle="Choose a source from the sidebar to inspect its provenance and indexed chunks."
        />
      </div>
    )
  }

  if (!loaded) {
    return <PageLoader label="Loading knowledge source..." />
  }

  if (error || !detail) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <EmptyState
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-accent-bright">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          }
          title="Knowledge source unavailable"
          subtitle={error || 'This source no longer exists.'}
          action={{ label: 'Retry', onClick: () => { void loadDetail(selectedKnowledgeSourceId) } }}
        />
      </div>
    )
  }

  const { source, chunks } = detail
  const scopedAgents = source.agentIds.map((id) => agents[id]).filter(Boolean)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1040px] mx-auto px-6 py-6 space-y-6">
        <div className="rounded-[20px] border border-white/[0.06] bg-raised/60 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <h1 className="font-display text-[24px] font-700 tracking-[-0.03em] text-text truncate">{source.title}</h1>
                <Badge variant="secondary" className="uppercase text-[10px] px-2 py-0.5">{source.kind}</Badge>
                <span className={`text-[11px] font-700 uppercase tracking-[0.08em] ${
                  source.syncStatus === 'error'
                    ? 'text-red-300'
                    : source.stale
                      ? 'text-amber-300'
                      : 'text-emerald-300'
                }`}
                >
                  {source.syncStatus === 'error' ? 'Sync error' : source.stale ? 'Stale' : 'Ready'}
                </span>
                {source.archivedAt ? <Badge variant="secondary" className="uppercase text-[10px] px-2 py-0.5 text-amber-200">archived</Badge> : null}
                {source.supersededBySourceId ? <Badge variant="secondary" className="uppercase text-[10px] px-2 py-0.5 text-text-3">superseded</Badge> : null}
              </div>

              {source.topSnippet && (
                <p className="text-[14px] text-text-3/75 max-w-[720px] leading-relaxed">{source.topSnippet}</p>
              )}

              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span className={`text-[11px] font-600 ${source.scope === 'global' ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {source.scope === 'global' ? 'Global access' : `${source.agentIds.length} agent(s)`}
                </span>
                <span className="text-[11px] text-text-3/55">
                  {source.chunkCount} chunk{source.chunkCount === 1 ? '' : 's'}
                </span>
                <span className="text-[11px] text-text-3/55">
                  {source.contentLength.toLocaleString()} chars
                </span>
              </div>

              {source.tags.length > 0 && (
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {source.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px] px-2 py-0.5">{tag}</Badge>
                  ))}
                </div>
              )}

              {scopedAgents.length > 0 && (
                <div className="flex items-center gap-2 mt-3">
                  <div className="flex items-center -space-x-1.5">
                    {scopedAgents.map((agent) => (
                      <AgentAvatar
                        key={agent.id}
                        seed={agent.avatarSeed}
                        avatarUrl={agent.avatarUrl}
                        name={agent.name}
                        size={20}
                        className="ring-1 ring-surface"
                      />
                    ))}
                  </div>
                  <span className="text-[11px] text-text-3/60">
                    {scopedAgents.map((agent) => agent.name).join(', ')}
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => { void handleSync() }}
                disabled={syncing}
                className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] text-[12px] font-600 text-text-2 hover:bg-white/[0.05] disabled:opacity-50 transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                {syncing ? 'Syncing...' : 'Sync'}
              </button>
              <button
                onClick={openEdit}
                className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] text-[12px] font-600 text-text-2 hover:bg-white/[0.05] transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                Edit
              </button>
              {source.archivedAt ? (
                <button
                  onClick={() => { void handleRestore() }}
                  disabled={restoring}
                  className="px-3 py-2 rounded-[10px] border border-emerald-500/15 bg-emerald-500/[0.06] text-[12px] font-600 text-emerald-100 hover:bg-emerald-500/[0.1] disabled:opacity-50 transition-all cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  {restoring ? 'Restoring...' : 'Restore'}
                </button>
              ) : (
                <button
                  onClick={() => { void handleArchive() }}
                  disabled={archiving}
                  className="px-3 py-2 rounded-[10px] border border-amber-500/15 bg-amber-500/[0.06] text-[12px] font-600 text-amber-100 hover:bg-amber-500/[0.1] disabled:opacity-50 transition-all cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  {archiving ? 'Archiving...' : 'Archive'}
                </button>
              )}
              <button
                onClick={() => { void handleDelete() }}
                disabled={deleting}
                className="px-3 py-2 rounded-[10px] border border-red-500/15 bg-red-500/[0.06] text-[12px] font-600 text-red-200 hover:bg-red-500/[0.1] disabled:opacity-50 transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-6">
            <div className="rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-4">
              <p className="text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/55 mb-1">Source</p>
              <p className="text-[13px] text-text-2">{source.sourceLabel || 'Manual note'}</p>
              {source.sourceUrl && (
                <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="text-[12px] text-accent-bright hover:underline break-all">
                  {source.sourceUrl}
                </a>
              )}
              {source.sourcePath && (
                <p className="text-[12px] text-text-3/65 break-all mt-1">{source.sourcePath}</p>
              )}
            </div>

            <div className="rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-4">
              <p className="text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/55 mb-1">Indexing</p>
              <p className="text-[12px] text-text-2">Last indexed: {formatDateTime(source.lastIndexedAt)}</p>
              <p className="text-[12px] text-text-3/70 mt-1">Last sync: {formatDateTime(source.lastSyncedAt)}</p>
              {source.maintenanceUpdatedAt ? (
                <p className="text-[12px] text-text-3/70 mt-1">Last maintenance: {formatDateTime(source.maintenanceUpdatedAt)}</p>
              ) : null}
              {source.maintenanceNotes ? (
                <p className="text-[12px] text-text-3/70 mt-1">{source.maintenanceNotes}</p>
              ) : null}
              {source.archivedReason ? (
                <p className="text-[12px] text-text-3/70 mt-1">Archive reason: {source.archivedReason}</p>
              ) : null}
              {source.lastError && (
                <p className="text-[12px] text-red-200 mt-2">{source.lastError}</p>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-4">
            <p className="text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/55 mb-2">Supersede Source</p>
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <input
                value={supersedeTargetId}
                onChange={(event) => setSupersedeTargetId(event.target.value)}
                placeholder="Replacement source id"
                className="w-full rounded-[10px] border border-white/[0.08] bg-surface px-3 py-2 text-[13px] text-text outline-none"
              />
              <button
                onClick={() => { void handleSupersede() }}
                disabled={!supersedeTargetId.trim()}
                className="rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] font-600 text-text-2 transition-all cursor-pointer disabled:opacity-50"
                style={{ fontFamily: 'inherit' }}
              >
                Mark superseded
              </button>
            </div>
            {source.supersededBySourceId && (
              <p className="mt-2 text-[12px] text-text-3/70">Superseded by {source.supersededBySourceId}</p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-[16px] font-600 text-text-2 tracking-[-0.02em]">Indexed Chunks</h2>
            <span className="text-[11px] text-text-3/55">{chunks.length} result{chunks.length === 1 ? '' : 's'}</span>
          </div>

          {chunks.map((chunk) => {
            const metadata = chunk.metadata && typeof chunk.metadata === 'object'
              ? chunk.metadata as Record<string, unknown>
              : {}
            const sectionLabel = typeof metadata.sectionLabel === 'string' ? metadata.sectionLabel : null
            const chunkIndex = typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : 0
            const chunkCount = typeof metadata.chunkCount === 'number' ? metadata.chunkCount : chunks.length
            const charStart = typeof metadata.charStart === 'number' ? metadata.charStart : 0
            const charEnd = typeof metadata.charEnd === 'number' ? metadata.charEnd : chunk.content.length

            return (
              <div key={chunk.id} className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <p className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/55">
                      Chunk {chunkIndex + 1} of {chunkCount}
                    </p>
                    <h3 className="font-display text-[15px] font-600 text-text-2 mt-1">
                      {sectionLabel || chunk.title || source.title}
                    </h3>
                  </div>
                  <span className="text-[11px] text-text-3/55 font-mono">
                    {charStart.toLocaleString()}-{charEnd.toLocaleString()}
                  </span>
                </div>
                <p className="text-[13px] text-text-2/85 whitespace-pre-wrap break-words leading-relaxed">{chunk.content}</p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
