'use client'

import { useEffect, useState, useCallback } from 'react'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'

interface CanvasPanelProps {
  sessionId: string
  agentName?: string
  onClose: () => void
}

export function CanvasPanel({ sessionId, agentName, onClose }: CanvasPanelProps) {
  const [content, setContent] = useState<string | null>(null)

  const loadCanvas = useCallback(async () => {
    try {
      const res = await api<{ content: string | null }>('GET', `/canvas/${sessionId}`)
      setContent(res.content)
    } catch { /* ignore */ }
  }, [sessionId])

  useEffect(() => { loadCanvas() }, [loadCanvas]) // eslint-disable-line react-hooks/set-state-in-effect
  useWs(`canvas:${sessionId}`, loadCanvas, 10_000)

  if (!content) return (
    <div className="flex flex-col h-full border-l border-white/[0.06] bg-bg min-w-[400px]">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright shrink-0">
          <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />
        </svg>
        <span className="text-[13px] font-600 text-text flex-1 truncate">
          Canvas{agentName ? ` — ${agentName}` : ''}
        </span>
        <button
          onClick={onClose}
          className="p-1.5 rounded-[6px] hover:bg-white/[0.06] transition-colors cursor-pointer border-none bg-transparent text-text-3 hover:text-text-2"
          title="Close canvas"
          aria-label="Close canvas"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 rounded-full border-2 border-text-3/20 border-t-accent-bright animate-spin mx-auto mb-3" />
          <span className="text-[13px] text-text-3">Loading canvas...</span>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-full border-l border-white/[0.06] bg-bg min-w-[400px]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright shrink-0">
          <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />
        </svg>
        <span className="text-[13px] font-600 text-text flex-1 truncate">
          Canvas{agentName ? ` — ${agentName}` : ''}
        </span>
        <button
          onClick={loadCanvas}
          className="p-1.5 rounded-[6px] hover:bg-white/[0.06] transition-colors cursor-pointer border-none bg-transparent text-text-3 hover:text-text-2"
          title="Refresh"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded-[6px] hover:bg-white/[0.06] transition-colors cursor-pointer border-none bg-transparent text-text-3 hover:text-text-2"
          title="Close canvas"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Sandboxed iframe */}
      <div className="flex-1 overflow-hidden">
        <iframe
          sandbox="allow-scripts allow-same-origin"
          srcDoc={content}
          className="w-full h-full border-none bg-white"
          title="Agent Canvas"
        />
      </div>
    </div>
  )
}
