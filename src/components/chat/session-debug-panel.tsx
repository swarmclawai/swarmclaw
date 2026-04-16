'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Message } from '@/types'
import { IconButton } from '@/components/shared/icon-button'
import { CheckpointTimeline } from './checkpoint-timeline'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'

interface Props {
  messages: Message[]
  open: boolean
  onClose: () => void
}

type EventType = 'user' | 'assistant' | 'delegation' | 'agent_result' | 'system' | 'error' | 'tool_call'

interface DebugEvent {
  type: EventType
  label: string
  detail: string
  extraDetail?: Record<string, unknown> | null
  time: number
  source: 'message' | 'execlog'
}

interface ExecLogEntry {
  id: string
  sessionId: string
  runId: string | null
  agentId: string | null
  category: string
  summary: string
  detail: Record<string, unknown> | null
  ts: number
}

function classifyMessage(msg: Message): DebugEvent {
  const text = msg.text || ''

  if (msg.role === 'user') {
    if (text.startsWith('[System]')) {
      return { type: 'system', label: 'System', detail: text.replace('[System] ', ''), time: msg.time, source: 'message' }
    }
    if (text.startsWith('[Agent ')) {
      const match = text.match(/\[Agent (.+?) result\]/)
      return { type: 'agent_result', label: `Agent: ${match?.[1] || 'Unknown'}`, detail: text.replace(/\[Agent .+? result\]:?\n?/, ''), time: msg.time, source: 'message' }
    }
    if (text.startsWith('[Memory search')) {
      return { type: 'system', label: 'Memory Search', detail: text.replace('[Memory search results]:\n', ''), time: msg.time, source: 'message' }
    }
    return { type: 'user', label: 'User', detail: text, time: msg.time, source: 'message' }
  }

  // assistant
  if (text.startsWith('[Delegating to ')) {
    const match = text.match(/\[Delegating to (.+?)\]/)
    return { type: 'delegation', label: `Delegate: ${match?.[1] || 'Unknown'}`, detail: text.replace(/\[Delegating to .+?\]:?\s?/, ''), time: msg.time, source: 'message' }
  }
  if (text.startsWith('[Error]')) {
    return { type: 'error', label: 'Error', detail: text.replace('[Error] ', ''), time: msg.time, source: 'message' }
  }
  if (text.startsWith('Starting task:')) {
    return { type: 'system', label: 'Task Start', detail: text, time: msg.time, source: 'message' }
  }
  return { type: 'assistant', label: 'Assistant', detail: text, time: msg.time, source: 'message' }
}

function classifyExecLogEntry(entry: ExecLogEntry): DebugEvent {
  const catMap: Record<string, EventType> = {
    error: 'error',
    tool_call: 'tool_call',
    tool_result: 'tool_call',
    decision: 'system',
    trigger: 'system',
    loop_detection: 'system',
    delegation_start: 'delegation',
    delegation_complete: 'agent_result',
    delegation_fail: 'error',
  }
  const type: EventType = catMap[entry.category] ?? 'system'
  const labelMap: Record<string, string> = {
    error: 'Error',
    tool_call: 'Tool Call',
    tool_result: 'Tool Result',
    decision: 'Decision',
    trigger: 'Trigger',
    loop_detection: 'Loop Detect',
    delegation_start: 'Delegation',
    delegation_complete: 'Delegation Result',
    delegation_fail: 'Delegation Error',
    heartbeat_failure: 'Heartbeat Fail',
  }
  const label = labelMap[entry.category] ?? entry.category.replace(/_/g, ' ')
  return {
    type,
    label,
    detail: entry.summary,
    extraDetail: entry.detail,
    time: entry.ts,
    source: 'execlog',
  }
}

const TYPE_COLORS: Record<EventType, string> = {
  user: '#6366F1',
  assistant: '#a0a0b0',
  delegation: '#F59E0B',
  agent_result: '#10B981',
  system: '#6B7280',
  error: '#EF4444',
  tool_call: '#8B5CF6',
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ExtraDetail({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined)
  if (entries.length === 0) return null
  return (
    <div className="mt-2 rounded-[8px] bg-black/30 border border-white/[0.06] p-3 text-[11px] font-mono space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 flex-wrap">
          <span className="text-text-3/70 shrink-0">{k}:</span>
          <span className="text-text-2 break-all">
            {Array.isArray(v)
              ? v.map(String).join(', ') || '(empty)'
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function SessionDebugPanel({ messages, open, onClose }: Props) {
  const [tab, setTab] = useState<'log' | 'checkpoints'>('log')
  const [filter, setFilter] = useState<EventType | 'all'>('all')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [execLogs, setExecLogs] = useState<ExecLogEntry[]>([])
  const [loadingExec, setLoadingExec] = useState(false)

  const currentSessionId = useAppStore(selectActiveSessionId)

  const fetchExecLogs = useCallback(async (sessionId: string) => {
    setLoadingExec(true)
    try {
      const res = await fetch(`/api/chats/${sessionId}/execution-log?limit=200`)
      if (res.ok) {
        const data = await res.json() as ExecLogEntry[]
        setExecLogs(Array.isArray(data) ? data : [])
      }
    } catch {
      // non-critical
    } finally {
      setLoadingExec(false)
    }
  }, [])

  useEffect(() => {
    if (open && currentSessionId) {
      void fetchExecLogs(currentSessionId)
    } else if (!open) {
      setExecLogs([])
      setExpandedIdx(null)
    }
  }, [open, currentSessionId, fetchExecLogs])

  const msgEvents = messages.map(classifyMessage)
  const execEvents = execLogs.map(classifyExecLogEntry)

  // Merge and sort by time
  const allEvents = [...msgEvents, ...execEvents].sort((a, b) => a.time - b.time)
  const events = allEvents
  const filtered = filter === 'all' ? events : events.filter((e) => e.type === filter)

  if (!open) return null

  const filters: { id: EventType | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'delegation', label: 'Delegations' },
    { id: 'agent_result', label: 'Results' },
    { id: 'error', label: 'Errors' },
    { id: 'system', label: 'System' },
    { id: 'tool_call', label: 'Tools' },
  ]

  return (
    <div className="absolute inset-0 z-30 bg-bg/95 backdrop-blur-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.06] shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366F1" strokeWidth="2" strokeLinecap="round">
          <path d="M12 20V10" />
          <path d="M18 20V4" />
          <path d="M6 20v-4" />
        </svg>
        <span className="font-display text-[16px] font-600 tracking-[-0.02em] flex-1">Session X-Ray</span>

        <div className="flex bg-white/[0.04] p-0.5 rounded-[8px] mr-2">
          <button
            onClick={() => setTab('log')}
            className={`px-3 py-1 rounded-[6px] text-[11px] font-600 transition-all ${tab === 'log' ? 'bg-white/[0.08] text-text shadow-sm' : 'text-text-3 hover:text-text-2'}`}
          >
            Event Log
          </button>
          <button
            onClick={() => setTab('checkpoints')}
            className={`px-3 py-1 rounded-[6px] text-[11px] font-600 transition-all ${tab === 'checkpoints' ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:text-text-2'}`}
          >
            Checkpoints
          </button>
        </div>

        <IconButton onClick={onClose} aria-label="Close debug panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </IconButton>
      </div>

      {tab === 'log' ? (
        <>
          {/* Filters */}
          <div className="flex gap-2 px-5 py-3 border-b border-white/[0.04] overflow-x-auto shrink-0">
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border whitespace-nowrap
                  ${filter === f.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {f.label}
              </button>
            ))}
            {currentSessionId && (
              <button
                onClick={() => void fetchExecLogs(currentSessionId)}
                disabled={loadingExec}
                className="ml-auto px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border bg-surface border-white/[0.06] text-text-3 hover:text-text-2 disabled:opacity-40 whitespace-nowrap"
                style={{ fontFamily: 'inherit' }}
              >
                {loadingExec ? 'Refreshing…' : '↺ Refresh'}
              </button>
            )}
          </div>

          {/* Event timeline */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[15px] top-0 bottom-0 w-px bg-white/[0.06]" />

              {filtered.map((event, i) => {
                const color = TYPE_COLORS[event.type]
                const expanded = expandedIdx === i
                return (
                  <button
                    key={i}
                    onClick={() => setExpandedIdx(expanded ? null : i)}
                    className="w-full text-left relative pl-10 pb-4 group cursor-pointer"
                  >
                    {/* Dot */}
                    <div
                      className="absolute left-[10px] top-1 w-[11px] h-[11px] rounded-full border-2"
                      style={{ borderColor: color, backgroundColor: expanded ? color : 'transparent' }}
                    />

                    {/* Content */}
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="text-[11px] font-700 uppercase tracking-wider" style={{ color }}>
                        {event.label}
                      </span>
                      <span className="text-[10px] text-text-3/70 font-mono">{fmtTime(event.time)}</span>
                      {event.source === 'execlog' && (
                        <span className="text-[9px] text-text-3/40 font-mono uppercase tracking-wider">exec</span>
                      )}
                    </div>

                    <p className={`text-[12px] text-text-3 leading-[1.5] ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                      {event.detail}
                    </p>

                    {expanded && event.extraDetail && (
                      <ExtraDetail data={event.extraDetail} />
                    )}

                    {!expanded && event.detail.length > 150 && (
                      <span className="text-[11px] text-accent-bright/60 mt-1 inline-block">click to expand</span>
                    )}
                    {!expanded && event.extraDetail && Object.keys(event.extraDetail).length > 0 && (
                      <span className="text-[11px] text-accent-bright/60 mt-1 inline-block ml-2">+ details</span>
                    )}
                  </button>
                )
              })}

              {filtered.length === 0 && !loadingExec && (
                <p className="text-center text-[13px] text-text-3 py-12">No events matching filter</p>
              )}
              {filtered.length === 0 && loadingExec && (
                <p className="text-center text-[13px] text-text-3 py-12">Loading…</p>
              )}
            </div>
          </div>

          {/* Stats bar */}
          <div className="flex items-center gap-4 px-5 py-3 border-t border-white/[0.06] shrink-0">
            {(['delegation', 'agent_result', 'error'] as EventType[]).map((type) => {
              const count = events.filter((e) => e.type === type).length
              if (!count) return null
              return (
                <span key={type} className="flex items-center gap-1.5 text-[11px] font-mono" style={{ color: TYPE_COLORS[type] }}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                  {count} {type === 'delegation' ? 'delegations' : type === 'agent_result' ? 'results' : 'errors'}
                </span>
              )
            })}
            <span className="ml-auto text-[10px] text-text-3/40 font-mono">{execLogs.length} exec log entries</span>
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {currentSessionId ? (
            <CheckpointTimeline sessionId={currentSessionId} />
          ) : (
            <div className="p-12 text-center text-text-3">No active chat</div>
          )}
        </div>
      )}
    </div>
  )
}

