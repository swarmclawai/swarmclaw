'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import type { ActivityEntry } from '@/types'

const ENTITY_ICONS: Record<string, string> = {
  agent: 'A', task: 'T', connector: 'C', session: 'S', webhook: 'W', schedule: 'R',
}

const ACTION_COLORS: Record<string, string> = {
  created: 'bg-emerald-500/15 text-emerald-400',
  updated: 'bg-blue-500/15 text-blue-400',
  deleted: 'bg-red-500/15 text-red-400',
  started: 'bg-green-500/15 text-green-400',
  stopped: 'bg-gray-500/15 text-gray-400',
  queued: 'bg-amber-500/15 text-amber-400',
  completed: 'bg-emerald-500/15 text-emerald-400',
  failed: 'bg-red-500/15 text-red-400',
  approved: 'bg-green-500/15 text-green-400',
  rejected: 'bg-red-500/15 text-red-400',
}

function timeAgo(ts: number) {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

const ENTITY_TYPES = ['', 'agent', 'task', 'connector', 'session', 'webhook', 'schedule'] as const

export function ActivityFeed() {
  const entries = useAppStore((s) => s.activityEntries)
  const loadActivity = useAppStore((s) => s.loadActivity)
  const [filterType, setFilterType] = useState('')

  useEffect(() => { loadActivity({ entityType: filterType || undefined, limit: 100 }) }, [filterType])
  useWs('activity', () => loadActivity({ entityType: filterType || undefined, limit: 100 }), 10_000)

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-8 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="font-display text-[28px] font-800 tracking-[-0.03em]">Activity</h1>
          <p className="text-[13px] text-text-3 mt-1">Audit trail of all entity mutations</p>
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03] appearance-none"
          style={{ fontFamily: 'inherit', minWidth: 130 }}
        >
          <option value="">All Types</option>
          {ENTITY_TYPES.filter(Boolean).map((t) => (
            <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}s</option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-6">
        {entries.length === 0 ? (
          <div className="text-center text-text-3 text-[14px] mt-16">No activity yet</div>
        ) : (
          <div className="space-y-1">
            {entries.map((entry: ActivityEntry) => (
              <div key={entry.id} className="flex items-start gap-3 py-3 border-b border-white/[0.04]">
                <div className="w-8 h-8 rounded-[8px] bg-surface-2 flex items-center justify-center text-[12px] font-700 text-text-3 shrink-0">
                  {ENTITY_ICONS[entry.entityType] || '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded-[5px] text-[10px] font-600 ${ACTION_COLORS[entry.action] || 'bg-white/[0.06] text-text-3'}`}>
                      {entry.action}
                    </span>
                    <span className="text-[10px] text-text-3/50 font-mono">{entry.entityType}</span>
                    <span className="text-[10px] text-text-3/40">{entry.actor}</span>
                  </div>
                  <p className="text-[13px] text-text-2 leading-[1.4] truncate">{entry.summary}</p>
                </div>
                <span className="text-[11px] text-text-3/50 shrink-0 pt-1">{timeAgo(entry.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
