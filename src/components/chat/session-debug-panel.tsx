'use client'

import { useState, useEffect } from 'react'
import type { Message } from '@/types'
import { IconButton } from '@/components/shared/icon-button'

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
  time: number
}

function classifyMessage(msg: Message): DebugEvent {
  const text = msg.text || ''

  if (msg.role === 'user') {
    if (text.startsWith('[System]')) {
      return { type: 'system', label: 'System', detail: text.replace('[System] ', ''), time: msg.time }
    }
    if (text.startsWith('[Agent ')) {
      const match = text.match(/\[Agent (.+?) result\]/)
      return { type: 'agent_result', label: `Agent: ${match?.[1] || 'Unknown'}`, detail: text.replace(/\[Agent .+? result\]:?\n?/, ''), time: msg.time }
    }
    if (text.startsWith('[Memory search')) {
      return { type: 'system', label: 'Memory Search', detail: text.replace('[Memory search results]:\n', ''), time: msg.time }
    }
    return { type: 'user', label: 'User', detail: text, time: msg.time }
  }

  // assistant
  if (text.startsWith('[Delegating to ')) {
    const match = text.match(/\[Delegating to (.+?)\]/)
    return { type: 'delegation', label: `Delegate: ${match?.[1] || 'Unknown'}`, detail: text.replace(/\[Delegating to .+?\]:?\s?/, ''), time: msg.time }
  }
  if (text.startsWith('[Error]')) {
    return { type: 'error', label: 'Error', detail: text.replace('[Error] ', ''), time: msg.time }
  }
  if (text.startsWith('Starting task:')) {
    return { type: 'system', label: 'Task Start', detail: text, time: msg.time }
  }
  return { type: 'assistant', label: 'Assistant', detail: text, time: msg.time }
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

const TYPE_ICONS: Record<EventType, string> = {
  user: 'U',
  assistant: 'AI',
  delegation: 'D',
  agent_result: 'R',
  system: 'S',
  error: '!',
  tool_call: 'T',
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function SessionDebugPanel({ messages, open, onClose }: Props) {
  const [filter, setFilter] = useState<EventType | 'all'>('all')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  const events = messages.map(classifyMessage)
  const filtered = filter === 'all' ? events : events.filter((e) => e.type === filter)

  // Auto-scroll to bottom
  useEffect(() => {
    setExpandedIdx(null)
  }, [messages.length])

  if (!open) return null

  const filters: { id: EventType | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'delegation', label: 'Delegations' },
    { id: 'agent_result', label: 'Results' },
    { id: 'error', label: 'Errors' },
    { id: 'system', label: 'System' },
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
        <span className="font-display text-[16px] font-600 tracking-[-0.02em] flex-1">Session Debug</span>
        <span className="text-[12px] text-text-3 font-mono">{events.length} events</span>
        <IconButton onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </IconButton>
      </div>

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
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-700 uppercase tracking-wider" style={{ color }}>
                    {event.label}
                  </span>
                  <span className="text-[10px] text-text-3/40 font-mono">{fmtTime(event.time)}</span>
                </div>

                <p className={`text-[12px] text-text-3 leading-[1.5] ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                  {event.detail}
                </p>

                {!expanded && event.detail.length > 150 && (
                  <span className="text-[11px] text-accent-bright/60 mt-1 inline-block">click to expand</span>
                )}
              </button>
            )
          })}

          {filtered.length === 0 && (
            <p className="text-center text-[13px] text-text-3 py-12">No events matching filter</p>
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
      </div>
    </div>
  )
}
