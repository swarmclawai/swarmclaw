'use client'

import { useState, useEffect, useCallback } from 'react'
import type { DreamCycle } from '@/types'

interface Props {
  agentId: string
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`
}

function timeAgo(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const statusColors: Record<string, string> = {
  completed: 'bg-emerald-400/10 text-emerald-300',
  running: 'bg-amber-400/10 text-amber-300',
  pending: 'bg-amber-400/10 text-amber-300',
  failed: 'bg-red-400/10 text-red-300',
}

export function DreamHistory({ agentId }: Props) {
  const [cycles, setCycles] = useState<DreamCycle[]>([])
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/memory/dream?agentId=${encodeURIComponent(agentId)}&limit=10`)
      const data = await res.json() as { ok: boolean; cycles?: DreamCycle[]; error?: string }
      if (data.ok && Array.isArray(data.cycles)) {
        setCycles(data.cycles)
      } else {
        setError(data.error || 'Failed to load dream cycles')
      }
    } catch {
      setError('Unable to reach the server')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

  const handleTrigger = async () => {
    try {
      setTriggering(true)
      setError(null)
      const res = await fetch('/api/memory/dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      })
      const data = await res.json() as { ok: boolean; error?: string }
      if (!data.ok) {
        setError(data.error || 'Dream trigger failed')
      }
      await load()
    } catch {
      setError('Unable to trigger dream cycle')
    } finally {
      setTriggering(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-display text-[14px] font-600 text-text">Dream History</h4>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void load() }}
            disabled={loading}
            className="px-2.5 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] font-600 text-text-3 hover:bg-white/[0.04] hover:text-text-2 transition-all cursor-pointer disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => { void handleTrigger() }}
            disabled={triggering}
            className="px-2.5 py-1.5 rounded-[8px] bg-accent-soft text-accent-bright text-[11px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            {triggering ? 'Running...' : 'Trigger Dream'}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-[12px] text-red-400/80 leading-[1.5]">{error}</p>
      )}

      {loading && cycles.length === 0 ? (
        <p className="text-[12px] text-text-3/60 py-4 text-center">Loading dream cycles...</p>
      ) : cycles.length === 0 ? (
        <p className="text-[12px] text-text-3/60 py-4 text-center">No dream cycles yet. Trigger one manually or enable dreaming in agent settings.</p>
      ) : (
        <div className="space-y-2">
          {cycles.map((cycle) => (
            <div
              key={cycle.id}
              className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3.5 py-3"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-1.5 py-0.5 rounded-[5px] text-[9px] font-700 uppercase tracking-[0.08em] ${statusColors[cycle.status] || 'bg-white/[0.04] text-text-3/75'}`}>
                  {cycle.status}
                </span>
                <span className="px-1.5 py-0.5 rounded-[5px] text-[9px] font-700 uppercase tracking-[0.08em] bg-white/[0.04] text-text-3/75">
                  {cycle.trigger}
                </span>
                {cycle.status === 'completed' && cycle.startedAt && cycle.completedAt && (
                  <span className="text-[10px] text-text-3/50 font-mono tabular-nums">
                    {formatDuration(cycle.completedAt - cycle.startedAt)}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-text-3/50 tabular-nums font-mono">
                  {timeAgo(cycle.startedAt, now)}
                </span>
              </div>
              {cycle.status === 'completed' && cycle.result && (
                <p className="mt-1.5 text-[11px] text-text-3/70 leading-[1.5]">
                  {cycle.result.decayed} decayed, {cycle.result.pruned} pruned, {cycle.result.promoted} promoted, {cycle.result.consolidated} consolidated
                </p>
              )}
              {cycle.status === 'failed' && cycle.error && (
                <p className="mt-1.5 text-[11px] text-red-400/70 leading-[1.5] line-clamp-2">{cycle.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
