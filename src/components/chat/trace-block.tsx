'use client'

import { useState } from 'react'
import type { ChatTraceBlock } from '@/types'

interface Props {
  trace: ChatTraceBlock
}

export function TraceBlock({ trace }: Props) {
  const [collapsed, setCollapsed] = useState(trace.collapsed !== false)

  const bgColor = trace.type === 'thinking'
    ? 'bg-purple-500/[0.04] border-purple-500/10'
    : trace.type === 'tool-call'
      ? 'bg-sky-500/[0.04] border-sky-500/10'
      : 'bg-emerald-500/[0.04] border-emerald-500/10'

  const labelColor = trace.type === 'thinking'
    ? 'text-purple-400/70'
    : trace.type === 'tool-call'
      ? 'text-sky-400/70'
      : 'text-emerald-400/70'

  const icon = trace.type === 'thinking'
    ? '...'
    : trace.type === 'tool-call'
      ? '>'
      : '<'

  return (
    <div className={`my-1 rounded-[8px] border ${bgColor} overflow-hidden`}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer border-none bg-transparent transition-colors hover:bg-white/[0.02] ${labelColor}`}
        style={{ fontFamily: 'inherit' }}
      >
        <span className="font-mono text-[10px] w-4 shrink-0">{collapsed ? '+' : '-'}</span>
        <span className="font-mono text-[10px] shrink-0">{icon}</span>
        <span className="text-[11px] font-600 truncate">
          {trace.label || trace.type.replace('-', ' ')}
        </span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-2">
          <pre className={`text-[11px] leading-relaxed whitespace-pre-wrap break-words m-0 ${
            trace.type === 'thinking'
              ? 'text-text-3/60 italic'
              : 'text-text-3/70 font-mono'
          }`}>
            {trace.content.length > 2000
              ? trace.content.slice(0, 2000) + '\n... (truncated)'
              : trace.content}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Parse message text with [[prefix]] markers into text and trace blocks */
export function parseTraceBlocks(text: string): Array<{ type: 'text'; content: string } | ChatTraceBlock> {
  const blocks: Array<{ type: 'text'; content: string } | ChatTraceBlock> = []
  const regex = /\[\[(thinking|tool|tool-result|trace|meta)\]\]([\s\S]*?)(?=\[\[(thinking|tool|tool-result|trace|meta)\]\]|$)/g

  let lastEnd = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Add any text before this match
    if (match.index > lastEnd) {
      const before = text.slice(lastEnd, match.index).trim()
      if (before) blocks.push({ type: 'text', content: before })
    }

    const prefix = match[1]
    const content = match[2].trim()
    if (content) {
      if (prefix === 'thinking' || prefix === 'trace') {
        blocks.push({ type: 'thinking', content, collapsed: true })
      } else if (prefix === 'tool') {
        const firstLine = content.split('\n')[0] || ''
        blocks.push({ type: 'tool-call', content, label: firstLine.slice(0, 60), collapsed: true })
      } else if (prefix === 'tool-result') {
        blocks.push({ type: 'tool-result', content, collapsed: true })
      }
      // meta is ignored
    }

    lastEnd = match.index + match[0].length
  }

  // Add remaining text
  if (lastEnd === 0) {
    // No trace markers found
    if (text.trim()) blocks.push({ type: 'text', content: text })
  } else if (lastEnd < text.length) {
    const remaining = text.slice(lastEnd).trim()
    if (remaining) blocks.push({ type: 'text', content: remaining })
  }

  return blocks
}
