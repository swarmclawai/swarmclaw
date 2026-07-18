'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { ClipboardList } from 'lucide-react'
import { api } from '@/lib/app/api-client'
import { useNow } from '@/hooks/use-now'
import { useWs } from '@/hooks/use-ws'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { EvidenceShelf } from '@/components/evidence/evidence-shelf'
import type { EvidenceArtifact, RunBrief, RunEventRecord, SessionRunRecord, SessionRunStatus } from '@/types'
import { PageLoader } from '@/components/ui/page-loader'
import { formatElapsed } from '@/lib/format-display'
import { GroundingPanel } from '@/components/knowledge/grounding-panel'
import { copyTextToClipboard } from '@/lib/clipboard'

const STATUS_COLORS: Record<SessionRunStatus, { bg: string; text: string }> = {
  queued: { bg: 'bg-yellow-500/10', text: 'text-yellow-400' },
  running: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  failed: { bg: 'bg-red-500/10', text: 'text-red-400' },
  cancelled: { bg: 'bg-white/[0.06]', text: 'text-text-3' },
}

const ALL_STATUSES: SessionRunStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']

function relativeTime(ts: number, now: number | null): string {
  if (!now) return 'recently'
  const diff = now - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}



export function RunList() {
  const now = useNow({ intervalMs: 1000 })
  const [runs, setRuns] = useState<SessionRunRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [statusFilter, setStatusFilter] = useState<SessionRunStatus | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SessionRunRecord | null>(null)
  const [selectedEvents, setSelectedEvents] = useState<RunEventRecord[]>([])
  const [selectedBrief, setSelectedBrief] = useState<RunBrief | null>(null)
  const [selectedArtifacts, setSelectedArtifacts] = useState<EvidenceArtifact[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [briefLoading, setBriefLoading] = useState(false)
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [handoffCopying, setHandoffCopying] = useState(false)
  const [handoffCopied, setHandoffCopied] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)

  const fetchRuns = useCallback(async () => {
    try {
      const res = await api<SessionRunRecord[]>('GET', '/runs?limit=200')
      setRuns(Array.isArray(res) ? res : [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchRuns()
  }, [fetchRuns])

  useWs('runs', fetchRuns, autoRefresh ? 3000 : undefined)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    void Promise.allSettled([
      api<RunEventRecord[]>('GET', `/runs/${selected.id}/events?limit=200`),
      api<RunBrief>('GET', `/runs/${selected.id}/brief`),
      api<EvidenceArtifact[]>('GET', `/artifacts?runId=${encodeURIComponent(selected.id)}`),
    ]).then(([eventsResult, briefResult, artifactsResult]) => {
      if (cancelled) return
      setSelectedEvents(eventsResult.status === 'fulfilled' && Array.isArray(eventsResult.value) ? eventsResult.value : [])
      setSelectedBrief(briefResult.status === 'fulfilled' ? briefResult.value : null)
      setSelectedArtifacts(artifactsResult.status === 'fulfilled' && Array.isArray(artifactsResult.value) ? artifactsResult.value : [])
    }).finally(() => {
      if (cancelled) return
      setEventsLoading(false)
      setBriefLoading(false)
      setArtifactsLoading(false)
    })
    return () => { cancelled = true }
  }, [selected])

  const closeSelected = useCallback(() => {
    setSelected(null)
    setSelectedEvents([])
    setSelectedBrief(null)
    setSelectedArtifacts([])
    setEventsLoading(false)
    setBriefLoading(false)
    setArtifactsLoading(false)
  }, [])

  const openSelected = useCallback((run: SessionRunRecord) => {
    setSelected(run)
    setSelectedEvents([])
    setSelectedBrief(null)
    setSelectedArtifacts([])
    setEventsLoading(true)
    setBriefLoading(true)
    setArtifactsLoading(true)
    setHandoffCopied(false)
    setHandoffError(null)
  }, [])

  const copyRunHandoff = useCallback(async () => {
    if (!selected || handoffCopying) return
    setHandoffCopying(true)
    setHandoffError(null)
    try {
      const markdown = await api<string>('GET', `/runs/${selected.id}/handoff?format=markdown`)
      const copied = await copyTextToClipboard(markdown)
      if (!copied) {
        setHandoffError('Clipboard unavailable.')
        return
      }
      setHandoffCopied(true)
      setTimeout(() => setHandoffCopied(false), 2000)
    } catch {
      setHandoffError('Could not copy handoff.')
    } finally {
      setHandoffCopying(false)
    }
  }, [handoffCopying, selected])

  const sources = useMemo(() => {
    return Array.from(new Set(runs.map((run) => run.source).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [runs])

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return runs.filter((run) => {
      if (statusFilter && run.status !== statusFilter) return false
      if (sourceFilter !== 'all' && run.source !== sourceFilter) return false
      if (!normalizedQuery) return true
      const searchable = [
        run.id,
        run.sessionId,
        run.source,
        run.messagePreview,
        run.error,
        run.resultPreview,
        run.kind,
        run.ownerType,
        run.ownerId,
      ]
      return searchable.some((value) => String(value || '').toLowerCase().includes(normalizedQuery))
    })
  }, [query, runs, sourceFilter, statusFilter])
  const selectedResultGrounding = selectedEvents
    .slice()
    .reverse()
    .find((event) => event.phase === 'status' && ((event.citations?.length || 0) > 0 || event.retrievalTrace?.hits?.length))

  if (loading) {
    return <PageLoader label="Loading runs..." />
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="px-5 py-2 space-y-2 shrink-0" style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
        {/* Status filter + auto-refresh */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setStatusFilter(null)}
            className={`px-2 py-1 rounded-[6px] text-[10px] font-700 uppercase tracking-wider cursor-pointer transition-all border-none ${
              !statusFilter ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.02] text-text-3/70'
            }`}
          >
            ALL
          </button>
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              className={`px-2 py-1 rounded-[6px] text-[10px] font-700 uppercase tracking-wider cursor-pointer transition-all border-none ${
                statusFilter === s ? `${STATUS_COLORS[s].bg} ${STATUS_COLORS[s].text}` : 'bg-white/[0.02] text-text-3/70'
              }`}
            >
              {s}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-2 py-1 rounded-[6px] text-[10px] font-600 cursor-pointer transition-all border-none flex items-center gap-1.5 ${
              autoRefresh ? 'bg-green-500/10 text-green-400' : 'bg-white/[0.04] text-text-3'
            }`}
          >
            {autoRefresh && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
            {autoRefresh ? 'LIVE' : 'PAUSED'}
          </button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 min-w-[180px]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3/50">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search run id, source, error, or result"
              className="w-full rounded-[8px] border border-white/[0.06] bg-white/[0.03] py-1.5 pl-8 pr-3 text-[12px] text-text outline-none transition-colors placeholder:text-text-3/45 focus:border-accent-bright/35"
            />
          </div>
          <label className="flex items-center gap-2 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/60">
            Source
            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              className="rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-2 py-1.5 text-[11px] font-600 normal-case tracking-normal text-text outline-none"
            >
              <option value="all">All sources</option>
              {sources.map((source) => (
                <option key={source} value={source}>{source}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Count */}
      <div className="px-5 py-1 text-[10px] text-text-3/60" style={{ animation: 'fade-in 0.6s ease 0.1s both' }}>
        {filtered.length} run{filtered.length !== 1 ? 's' : ''}
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-3 text-[12px]" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
            No runs found
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((run, idx) => (
              <button
                key={run.id}
                onClick={() => openSelected(run)}
                className="w-full text-left p-3 rounded-[10px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer block hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  animation: 'fade-up 0.4s var(--ease-spring) both',
                  animationDelay: `${0.1 + idx * 0.02}s`
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] font-700 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px] ${STATUS_COLORS[run.status].bg} ${STATUS_COLORS[run.status].text}`}>
                    {run.status}
                  </span>
                  <span className="text-[11px] text-text-3/60 font-mono">{run.source}</span>
                  <span className="text-[10px] text-text-3/40 ml-auto">{relativeTime(run.queuedAt, now)}</span>
                </div>
                <div className="text-[12px] text-text-2 truncate">{run.messagePreview || run.id}</div>
                {run.startedAt && (
                  <div className="text-[10px] text-text-3/50 mt-1">
                    Duration: {formatElapsed(run.startedAt, run.endedAt, now)}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Detail Sheet */}
      <BottomSheet open={!!selected} onClose={closeSelected}>
        {selected && (
          <div style={{ animation: 'fade-in 0.3s ease' }}>
            <div className="mb-6">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`text-[11px] font-700 uppercase tracking-wider px-2.5 py-1 rounded-[6px] ${STATUS_COLORS[selected.status].bg} ${STATUS_COLORS[selected.status].text}`}>
                    {selected.status}
                  </span>
                  <span className="text-[12px] font-mono text-text-3/60">{selected.source}</span>
                </div>
                <button
                  type="button"
                  onClick={copyRunHandoff}
                  disabled={handoffCopying}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-[8px] border border-white/[0.07] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-700 text-text-2 transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <ClipboardList size={13} />
                  {handoffCopied ? 'Copied' : handoffCopying ? 'Copying...' : 'Copy Handoff'}
                </button>
              </div>
              {handoffError && <p className="mb-3 text-[11px] font-600 text-red-400">{handoffError}</p>}
              <h2 className="font-display text-[20px] font-700 tracking-[-0.02em] mb-2 leading-snug">
                Run Details
              </h2>
              <p className="text-[12px] text-text-3/60 font-mono">{selected.id}</p>
            </div>

            {/* Brief */}
            <div className="mb-6">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Brief</label>
              {briefLoading ? (
                <div className="rounded-[12px] border border-white/[0.04] bg-white/[0.02] p-4 text-[11px] text-text-3/60">
                  Loading brief...
                </div>
              ) : selectedBrief ? (
                <div className="rounded-[12px] border border-white/[0.05] bg-white/[0.025] p-4">
                  <div className="text-[13px] font-700 text-text">{selectedBrief.title}</div>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-3/70">{selectedBrief.objective}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-[10px] border border-white/[0.04] bg-white/[0.02] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/55">Owner</div>
                      <div className="mt-1 text-[11px] text-text-2">{selectedBrief.owner ? `${selectedBrief.owner.type}:${selectedBrief.owner.id}` : selectedBrief.source}</div>
                    </div>
                    <div className="rounded-[10px] border border-white/[0.04] bg-white/[0.02] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/55">Usage</div>
                      <div className="mt-1 text-[11px] text-text-2">
                        {selectedBrief.usage.inputTokens ?? 0} in / {selectedBrief.usage.outputTokens ?? 0} out
                        {selectedBrief.usage.estimatedCost != null ? ` - $${selectedBrief.usage.estimatedCost.toFixed(4)}` : ''}
                      </div>
                    </div>
                  </div>
                  {selectedBrief.warnings.length > 0 && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      {selectedBrief.warnings.map((warning) => (
                        <div key={warning} className="rounded-[9px] border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
                          {warning}
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedBrief.timeline.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {selectedBrief.timeline.slice(0, 5).map((item, index) => (
                        <span key={`${item.label}:${item.at}:${index}`} className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3/80">
                          {item.label} {new Date(item.at).toLocaleTimeString()}
                        </span>
                      ))}
                    </div>
                  )}
                  {selectedBrief.evidence.length > 0 && (
                    <div className="mt-3 text-[11px] text-text-3/65">
                      {selectedBrief.evidence.length} brief evidence item{selectedBrief.evidence.length === 1 ? '' : 's'} found.
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-[12px] border border-white/[0.04] bg-white/[0.02] p-4 text-[11px] text-text-3/60">
                  No brief available for this run.
                </div>
              )}
            </div>

            {/* Timing */}
            <div className="mb-6 space-y-2">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">Timing</label>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
                  <div className="text-[10px] text-text-3/60 mb-0.5">Queued</div>
                  <div className="text-[12px] text-text font-mono">{new Date(selected.queuedAt).toLocaleString()}</div>
                </div>
                {selected.startedAt && (
                  <div className="p-2.5 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
                    <div className="text-[10px] text-text-3/60 mb-0.5">Started</div>
                    <div className="text-[12px] text-text font-mono">{new Date(selected.startedAt).toLocaleString()}</div>
                  </div>
                )}
                {selected.endedAt && (
                  <div className="p-2.5 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
                    <div className="text-[10px] text-text-3/60 mb-0.5">Ended</div>
                    <div className="text-[12px] text-text font-mono">{new Date(selected.endedAt).toLocaleString()}</div>
                  </div>
                )}
                <div className="p-2.5 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
                  <div className="text-[10px] text-text-3/60 mb-0.5">Duration</div>
                  <div className="text-[12px] text-text font-mono">{formatElapsed(selected.startedAt, selected.endedAt, now)}</div>
                </div>
              </div>
            </div>

            {/* Message */}
            {selected.messagePreview && (
              <div className="mb-6">
                <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Message</label>
                <pre className="text-[11px] text-text-3/80 font-mono whitespace-pre-wrap break-all bg-white/[0.02] rounded-[12px] p-4 max-h-[200px] overflow-auto border border-white/[0.04]">
                  {selected.messagePreview}
                </pre>
              </div>
            )}

            {/* Error */}
            {selected.error && (
              <div className="mb-6">
                <label className="block font-display text-[12px] font-600 text-red-400 uppercase tracking-[0.08em] mb-2">错误</label>
                <pre className="text-[11px] text-red-300/80 font-mono whitespace-pre-wrap break-all bg-red-500/[0.05] rounded-[12px] p-4 max-h-[200px] overflow-auto border border-red-500/[0.1]">
                  {selected.error}
                </pre>
              </div>
            )}

            {/* Result */}
            {selected.resultPreview && (
              <div className="mb-6">
                <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Result</label>
                <pre className="text-[11px] text-text-3/80 font-mono whitespace-pre-wrap break-all bg-white/[0.02] rounded-[12px] p-4 max-h-[200px] overflow-auto border border-white/[0.04]">
                  {selected.resultPreview}
                </pre>
                {selectedResultGrounding && (
                  <div className="mt-3">
                    <GroundingPanel
                      citations={selectedResultGrounding.citations}
                      retrievalTrace={selectedResultGrounding.retrievalTrace}
                      compact
                    />
                  </div>
                )}
              </div>
            )}

            <div className="mb-6">
              <EvidenceShelf
                artifacts={selectedArtifacts}
                loading={artifactsLoading}
                title="Evidence Shelf"
                emptyLabel="No linked artifacts, files, reports, or citations for this run."
              />
            </div>

            <div className="mb-2">
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Replay</label>
              <div className="rounded-[12px] border border-white/[0.04] bg-white/[0.02] max-h-[260px] overflow-auto">
                {eventsLoading ? (
                  <div className="p-4 text-[11px] text-text-3/60">Loading events...</div>
                ) : selectedEvents.length === 0 ? (
                  <div className="p-4 text-[11px] text-text-3/60">No persisted replay events for this run.</div>
                ) : (
                  <div className="divide-y divide-white/[0.04]">
                    {selectedEvents.map((event) => (
                      <div key={event.id} className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] text-text-3/50 font-mono">{new Date(event.timestamp).toLocaleTimeString()}</span>
                          <span className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">{event.phase}</span>
                          {event.status && <span className="text-[10px] text-text-3/60">{event.status}</span>}
                        </div>
                        <div className="text-[11px] text-text-2 whitespace-pre-wrap break-words">
                          {event.summary || event.event.text || event.event.toolOutput || event.event.toolName || event.event.t}
                        </div>
                        {(event.citations?.length || event.retrievalTrace?.hits?.length) ? (
                          <div className="mt-2">
                            <GroundingPanel
                              citations={event.citations}
                              retrievalTrace={event.retrievalTrace}
                              compact
                            />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  )
}
