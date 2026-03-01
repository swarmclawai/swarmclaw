'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api-client'
import { useWs } from '@/hooks/use-ws'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import type { SessionRunRecord, SessionRunStatus } from '@/types'

const STATUS_COLORS: Record<SessionRunStatus, { bg: string; text: string }> = {
  queued: { bg: 'bg-yellow-500/10', text: 'text-yellow-400' },
  running: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  failed: { bg: 'bg-red-500/10', text: 'text-red-400' },
  cancelled: { bg: 'bg-white/[0.06]', text: 'text-text-3' },
}

const ALL_STATUSES: SessionRunStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function formatDuration(start?: number, end?: number): string {
  if (!start) return '-'
  const elapsed = (end || Date.now()) - start
  if (elapsed < 1000) return `${elapsed}ms`
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`
  return `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s`
}

export function RunList() {
  const [runs, setRuns] = useState<SessionRunRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [statusFilter, setStatusFilter] = useState<SessionRunStatus | null>(null)
  const [selected, setSelected] = useState<SessionRunRecord | null>(null)

  const fetchRuns = useCallback(async () => {
    try {
      const res = await api<SessionRunRecord[]>('GET', '/runs?limit=200')
      setRuns(Array.isArray(res) ? res : [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRuns()
  }, [fetchRuns])

  useWs('runs', fetchRuns, autoRefresh ? 3000 : undefined)

  const filtered = statusFilter ? runs.filter((r) => r.status === statusFilter) : runs

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-3 text-[13px]">
        Loading runs...
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="px-5 py-2 space-y-2 shrink-0">
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
            className={`px-2 py-1 rounded-[6px] text-[10px] font-600 cursor-pointer transition-all border-none ${
              autoRefresh ? 'bg-green-500/10 text-green-400' : 'bg-white/[0.04] text-text-3'
            }`}
          >
            {autoRefresh ? 'LIVE' : 'PAUSED'}
          </button>
        </div>
      </div>

      {/* Count */}
      <div className="px-5 py-1 text-[10px] text-text-3/60">
        {filtered.length} run{filtered.length !== 1 ? 's' : ''}
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-3 text-[12px]">
            No runs found
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelected(run)}
                className="w-full text-left p-3 rounded-[10px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer block"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] font-700 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px] ${STATUS_COLORS[run.status].bg} ${STATUS_COLORS[run.status].text}`}>
                    {run.status}
                  </span>
                  <span className="text-[11px] text-text-3/60 font-mono">{run.source}</span>
                  <span className="text-[10px] text-text-3/40 ml-auto">{relativeTime(run.queuedAt)}</span>
                </div>
                <div className="text-[12px] text-text-2 truncate">{run.messagePreview || run.id}</div>
                {run.startedAt && (
                  <div className="text-[10px] text-text-3/50 mt-1">
                    Duration: {formatDuration(run.startedAt, run.endedAt)}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Detail Sheet */}
      <BottomSheet open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-3">
                <span className={`text-[11px] font-700 uppercase tracking-wider px-2.5 py-1 rounded-[6px] ${STATUS_COLORS[selected.status].bg} ${STATUS_COLORS[selected.status].text}`}>
                  {selected.status}
                </span>
                <span className="text-[12px] font-mono text-text-3/60">{selected.source}</span>
              </div>
              <h2 className="font-display text-[20px] font-700 tracking-[-0.02em] mb-2 leading-snug">
                Run Details
              </h2>
              <p className="text-[12px] text-text-3/60 font-mono">{selected.id}</p>
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
                  <div className="text-[12px] text-text font-mono">{formatDuration(selected.startedAt, selected.endedAt)}</div>
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
                <label className="block font-display text-[12px] font-600 text-red-400 uppercase tracking-[0.08em] mb-2">Error</label>
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
              </div>
            )}
          </>
        )}
      </BottomSheet>
    </div>
  )
}
