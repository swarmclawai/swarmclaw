'use client'

import { useState } from 'react'
import type { ToolEvent } from '@/stores/use-chat-store'

const TOOL_COLORS: Record<string, string> = {
  execute_command: '#F59E0B',
  read_file: '#10B981',
  write_file: '#10B981',
  list_files: '#10B981',
  delegate_to_claude_code: '#6366F1',
}

const TOOL_LABELS: Record<string, string> = {
  execute_command: 'Shell',
  read_file: 'Read File',
  write_file: 'Write File',
  list_files: 'List Files',
  delegate_to_claude_code: 'Claude Code',
}

export function ToolCallBubble({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const color = TOOL_COLORS[event.name] || '#6366F1'
  const label = TOOL_LABELS[event.name] || event.name
  const isRunning = event.status === 'running'

  let inputPreview = ''
  try {
    const parsed = JSON.parse(event.input)
    inputPreview = parsed.command || parsed.filePath || parsed.dirPath || parsed.task?.slice(0, 60) || event.input.slice(0, 60)
  } catch {
    inputPreview = event.input.slice(0, 60)
  }

  return (
    <button
      onClick={() => setExpanded(!expanded)}
      className="w-full text-left rounded-[12px] border bg-surface/80 backdrop-blur-sm transition-all duration-200 hover:bg-surface-2 cursor-pointer"
      style={{ borderLeft: `3px solid ${color}`, borderColor: `${color}33` }}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        {isRunning ? (
          <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-current animate-spin" style={{ color, borderTopColor: 'transparent' }} />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        <span className="text-[12px] font-700 uppercase tracking-wider shrink-0" style={{ color }}>
          {label}
        </span>
        <span className="text-[12px] text-text-3 font-mono truncate flex-1">
          {inputPreview}
        </span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          className={`shrink-0 text-text-3/40 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {expanded && (
        <div className="px-3.5 pb-3 space-y-2">
          <div className="text-[11px] text-text-3/60 uppercase tracking-wider font-600">Input</div>
          <pre className="text-[12px] text-text-2 font-mono whitespace-pre-wrap break-all bg-bg/50 rounded-[8px] px-3 py-2 max-h-[120px] overflow-y-auto">
            {event.input}
          </pre>
          {event.output && (
            <>
              <div className="text-[11px] text-text-3/60 uppercase tracking-wider font-600 mt-2">Output</div>
              <pre className="text-[12px] text-text-2 font-mono whitespace-pre-wrap break-all bg-bg/50 rounded-[8px] px-3 py-2 max-h-[200px] overflow-y-auto">
                {event.output}
              </pre>
            </>
          )}
        </div>
      )}
    </button>
  )
}
