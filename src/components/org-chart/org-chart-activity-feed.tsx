'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWs } from '@/hooks/use-ws'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { Agent, ActivityEntry } from '@/types'
import { timeAgo } from '@/lib/time-format'

interface Props {
  agents: Record<string, Agent>
  onSelectAgent?: (agentId: string) => void
  onClose: () => void
}

const ACTION_COLORS: Record<string, string> = {
  created: 'text-emerald-400',
  updated: 'text-blue-400',
  deleted: 'text-red-400',
  started: 'text-emerald-400',
  completed: 'text-blue-400',
  failed: 'text-red-400',
  triggered: 'text-amber-400',
  delegated: 'text-purple-400',
  queried: 'text-sky-400',
  spawned: 'text-purple-400',
  timeout: 'text-amber-400',
  cancelled: 'text-gray-400',
  incident: 'text-red-400',
  running: 'text-blue-400',
  claimed: 'text-emerald-400',
}

const ACTION_DOT_COLORS: Record<string, string> = {
  created: 'bg-emerald-400',
  updated: 'bg-blue-400',
  deleted: 'bg-red-400',
  started: 'bg-emerald-400',
  completed: 'bg-blue-400',
  failed: 'bg-red-400',
  triggered: 'bg-amber-400',
  delegated: 'bg-purple-400',
  queried: 'bg-sky-400',
  spawned: 'bg-purple-400',
  timeout: 'bg-amber-400',
  cancelled: 'bg-gray-400',
  incident: 'bg-red-400',
  running: 'bg-blue-400',
  claimed: 'bg-emerald-400',
}

export function OrgChartActivityFeed({ agents, onSelectAgent, onClose }: Props) {
  const entries = useAppStore((s) => s.activityEntries)
  const loadActivity = useAppStore((s) => s.loadActivity)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(() => {
    loadActivity({ limit: 50 }).then(() => setLoaded(true)).catch(() => setLoaded(true))
  }, [loadActivity])

  useWs('activity', refresh, 15_000)

  useEffect(() => {
    refresh()
  }, [refresh])

  const loading = !loaded

  const agentForEntry = (entry: ActivityEntry): Agent | null => {
    if (entry.entityType === 'agent') return agents[entry.entityId] || null
    return null
  }

  return (
    <div className="absolute top-0 right-0 z-30 w-[320px] h-full bg-raised/95 backdrop-blur-sm border-l border-white/[0.06] shadow-xl shadow-black/30 flex flex-col overflow-hidden" onPointerDown={(e) => e.stopPropagation()}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <div className="flex-1 text-[13px] font-600 text-text">动态</div>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded-[6px] flex items-center justify-center text-text-3 hover:text-text hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto overscroll-contain" onWheel={(e) => e.stopPropagation()}>
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-[11px] text-text-3/50">Loading...</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-[11px] text-text-3/50">No activity yet</span>
          </div>
        ) : (
          <div className="flex flex-col">
            {entries.map((entry) => {
              const agent = agentForEntry(entry)
              const isClickable = !!agent && !!onSelectAgent
              const dotColor = ACTION_DOT_COLORS[entry.action] || 'bg-text-3/40'
              const actionColor = ACTION_COLORS[entry.action] || 'text-text-3'

              return (
                <div
                  key={entry.id}
                  className={`flex items-start gap-2.5 px-4 py-2.5 border-b border-white/[0.03] ${
                    isClickable ? 'cursor-pointer hover:bg-white/[0.02]' : ''
                  }`}
                  onClick={isClickable ? () => onSelectAgent(agent.id) : undefined}
                >
                  {/* Timeline dot */}
                  <div className="mt-1.5 shrink-0">
                    <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                  </div>

                  {/* Agent avatar or generic icon */}
                  <div className="shrink-0 mt-0.5">
                    {agent ? (
                      <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={20} />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center">
                        <span className="text-[8px] text-text-3/50">{entry.entityType.charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-text-2 leading-snug line-clamp-2">
                      {entry.summary}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-[9px] font-500 uppercase tracking-wider ${actionColor}`}>
                        {entry.action}
                      </span>
                      <span className="text-[9px] text-text-3/30">
                        {timeAgo(entry.timestamp)}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
