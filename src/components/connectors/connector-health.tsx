'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api-client'
import { useNow } from '@/hooks/use-now'
import type { ConnectorHealthEvent, ConnectorHealthEventType } from '@/types'

interface HealthResponse {
  events: ConnectorHealthEvent[]
  uptimePercent: number
}

const EVENT_CONFIG: Record<ConnectorHealthEventType, { color: string; label: string }> = {
  started: { color: 'bg-green-400', label: 'Started' },
  reconnected: { color: 'bg-green-400', label: 'Reconnected' },
  stopped: { color: 'bg-white/30', label: 'Stopped' },
  error: { color: 'bg-red-400', label: 'Error' },
  disconnected: { color: 'bg-amber-400', label: 'Disconnected' },
}

function formatTimestamp(ts: string, now: number | null): string {
  const d = new Date(ts)
  if (!now) return 'recently'
  const diffMs = now - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr = Math.floor(diffMs / 3_600_000)
  const diffDay = Math.floor(diffMs / 86_400_000)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function uptimeBadgeColor(pct: number): string {
  if (pct >= 99) return 'bg-green-500/15 text-green-400 border-green-500/20'
  if (pct >= 95) return 'bg-amber-500/15 text-amber-400 border-amber-500/20'
  return 'bg-red-500/15 text-red-400 border-red-500/20'
}

export function ConnectorHealth({ connectorId }: { connectorId: string }) {
  const now = useNow()
  const [data, setData] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const resp = await api<HealthResponse>('GET', `/connectors/${connectorId}/health`)
        if (!cancelled) setData(resp)
      } catch {
        // ignore fetch errors
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [connectorId])

  if (loading) {
    return (
      <div className="p-4 rounded-[14px] border border-white/[0.06] bg-white/[0.01]">
        <div className="text-[13px] text-text-3 animate-pulse">Loading health data...</div>
      </div>
    )
  }

  if (!data || data.events.length === 0) {
    return (
      <div className="p-4 rounded-[14px] border border-white/[0.06] bg-white/[0.01]">
        <div className="text-[13px] text-text-3">No health events recorded yet.</div>
      </div>
    )
  }

  // Show most recent events first (up to 50)
  const recentEvents = [...data.events].reverse().slice(0, 50)

  return (
    <div className="p-4 rounded-[14px] border border-white/[0.06] bg-white/[0.01] space-y-4">
      {/* Uptime badge */}
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-600 text-text-2">Health Timeline</div>
        <span className={`px-3 py-1 rounded-[8px] text-[12px] font-600 border ${uptimeBadgeColor(data.uptimePercent)}`}>
          {data.uptimePercent}% uptime
        </span>
      </div>

      {/* Timeline */}
      <div className="relative pl-5">
        {/* Vertical line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-white/[0.08]" />

        <div className="max-h-[320px] overflow-y-auto pr-2 space-y-3 sm:max-h-[38vh]">
          {recentEvents.map((ev) => {
            const cfg = EVENT_CONFIG[ev.event] ?? { color: 'bg-white/30', label: ev.event }
            return (
              <div key={ev.id} className="relative flex items-start gap-3">
                {/* Dot */}
                <div className={`absolute left-[-13px] top-[6px] w-[10px] h-[10px] rounded-full ${cfg.color} ring-2 ring-surface shrink-0`} />
                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-600 text-text-2">{cfg.label}</span>
                    <span className="text-[11px] text-text-3">{formatTimestamp(ev.timestamp, now)}</span>
                  </div>
                  {ev.message && (
                    <p className="text-[12px] text-text-3/70 mt-0.5 leading-[1.4] break-words">{ev.message}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
