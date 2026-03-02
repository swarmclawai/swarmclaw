'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import type { Message } from '@/types'

/* ─── Heartbeat meta parsing (shared with message-bubble) ─── */

interface HeartbeatMeta {
  goal?: string
  status?: string
  next_action?: string
}

function parseHeartbeatMeta(text: string): HeartbeatMeta | null {
  const match = text.match(/\[AGENT_HEARTBEAT_META\]\s*(\{[^\n]*\})/i)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(match[1])
    if (typeof parsed === 'object' && parsed !== null) return parsed as HeartbeatMeta
  } catch { /* ignore */ }
  return null
}

function heartbeatSummary(text: string): string {
  const clean = (text || '')
    .replace(/\bHEARTBEAT_OK\b/gi, '')
    .replace(/\[AGENT_HEARTBEAT_META\]\s*\{[^\n]*\}/gi, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\([^)]+\)/g, '$1')
    .replace(/\bHeartbeat Response\s*:\s*/gi, '')
    .replace(/\bCurrent (State|Status)\s*:\s*/gi, '')
    .replace(/\bRecent Progress\s*:\s*/gi, '')
    .replace(/\bNext (Step|Immediate Step)\s*:\s*/gi, '')
    .replace(/\bStatus\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'No new status update.'
  return clean
}

const STATUS_COLORS: Record<string, string> = {
  progress: '#F59E0B',
  ok: '#22C55E',
  idle: '#6B7280',
  blocked: '#EF4444',
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function isHeartbeatMessage(msg: Message): boolean {
  return msg.role === 'assistant' && (
    msg.kind === 'heartbeat' ||
    /^\s*HEARTBEAT_OK\b/i.test(msg.text || '') ||
    /^\s*NO_MESSAGE\b/i.test(msg.text || '')
  )
}

function inferStatus(msg: Message, meta: HeartbeatMeta | null): string {
  if (meta?.status) return meta.status.toLowerCase()
  if (msg.suppressed || /^\s*HEARTBEAT_OK\b/i.test(msg.text || '') || /^\s*NO_MESSAGE\b/i.test(msg.text || '')) return 'ok'
  if (msg.toolEvents?.length) return 'progress'
  return 'idle'
}

/* ─── Types ─── */

type FilterStatus = 'all' | 'progress' | 'ok' | 'idle' | 'blocked'

const FILTER_TABS: { id: FilterStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'progress', label: 'Progress' },
  { id: 'ok', label: 'OK' },
  { id: 'idle', label: 'Idle' },
  { id: 'blocked', label: 'Blocked' },
]

interface HeartbeatEntry {
  msg: Message
  meta: HeartbeatMeta | null
  status: string
  summary: string
}

/* ─── Component ─── */

interface Props {
  messages: Message[]
  agentHeartbeatGoal?: string
  onClose: () => void
}

export function HeartbeatHistoryPanel({ messages, agentHeartbeatGoal, onClose }: Props) {
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Build heartbeat entries
  const entries: HeartbeatEntry[] = useMemo(() => {
    return messages
      .filter(isHeartbeatMessage)
      .map((msg) => {
        const meta = parseHeartbeatMeta(msg.text || '')
        const status = inferStatus(msg, meta)
        const summary = heartbeatSummary(msg.text || '')
        return { msg, meta, status, summary }
      })
  }, [messages])

  // Apply filter
  const filtered = useMemo(() => {
    if (filter === 'all') return entries
    return entries.filter((e) => e.status === filter)
  }, [entries, filter])

  // Auto-scroll to bottom on open
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="w-[400px] shrink-0 border-l border-white/[0.06] bg-bg flex flex-col h-full overflow-hidden fade-up-delay">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-rose-400/70 shrink-0">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
          <h3 className="font-display text-[14px] font-600 text-text">Heartbeat History</h3>
          <span className="text-[11px] text-text-3/50 tabular-nums">{entries.length}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-[6px] text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-all hover:bg-white/[0.04]"
          aria-label="Close heartbeat history"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-0.5 px-3 pt-2 pb-1 overflow-x-auto shrink-0" role="tablist">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            onClick={() => { setFilter(tab.id); setExpandedIdx(null) }}
            aria-selected={filter === tab.id}
            className={`px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all whitespace-nowrap focus-visible:ring-1 focus-visible:ring-accent-bright/50
              ${filter === tab.id
                ? 'bg-accent-soft text-accent-bright'
                : 'bg-transparent text-text-3 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {tab.label}
            {tab.id !== 'all' && (
              <span className="ml-1 text-[10px] opacity-60">
                {entries.filter((e) => e.status === tab.id).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="text-text-3/30">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
            <span className="text-[13px] text-text-3/50">No heartbeat activity yet</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map((entry, i) => {
              const color = STATUS_COLORS[entry.status] || STATUS_COLORS.idle
              const goal = entry.meta?.goal || agentHeartbeatGoal
              const isExpanded = expandedIdx === i
              const toolNames = entry.msg.toolEvents?.map((te) => te.name).filter(Boolean) ?? []
              const uniqueTools = [...new Set(toolNames)]

              return (
                <button
                  key={`${entry.msg.time}-${i}`}
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  className="w-full text-left px-3 py-2.5 rounded-[10px] bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] transition-colors cursor-pointer group"
                  style={{ fontFamily: 'inherit' }}
                >
                  {/* Top row: status dot + time */}
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: color }}
                      title={entry.status}
                    />
                    <span className="text-[10px] font-600 uppercase tracking-wider" style={{ color }}>
                      {entry.status}
                    </span>
                    <span className="text-[10px] text-text-3/40 ml-auto tabular-nums">
                      {relativeTime(entry.msg.time)}
                    </span>
                  </div>

                  {/* Goal */}
                  {goal && (
                    <div className="text-[12px] text-text-2 mb-1 leading-snug line-clamp-2">
                      {goal}
                    </div>
                  )}

                  {/* Next action */}
                  {entry.meta?.next_action && (
                    <div className="text-[11px] text-text-3/70 mb-1 leading-snug">
                      Next: {entry.meta.next_action}
                    </div>
                  )}

                  {/* Tool chips */}
                  {uniqueTools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {uniqueTools.map((name) => (
                        <span key={name} className="px-1.5 py-0.5 rounded-[4px] text-[10px] font-600 bg-sky-400/[0.08] text-sky-400/70">
                          {name}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Expanded summary */}
                  {isExpanded && entry.summary && (
                    <div className="mt-2 pt-2 border-t border-white/[0.06] text-[12px] text-text-3 leading-relaxed whitespace-pre-wrap">
                      {entry.summary}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
