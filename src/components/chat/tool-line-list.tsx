'use client'

import { memo, useMemo, useState } from 'react'
import { extractMedia, formatJson, formatToolOutput, getInputPreview, getToolLabel } from './tool-call-bubble'
import type { ToolEvent } from '@/stores/use-chat-store'

/**
 * Compact one-line-per-tool list. Renders every tool the agent used as a single
 * truncated row (status icon + label + input preview). Clicking a row expands an
 * inline detail panel with the full input, output, and any captured media — so
 * each tool call can be inspected individually without expanding the rest.
 */
const ToolLineRow = memo(function ToolLineRow({ event, index }: { event: ToolEvent; index: number }) {
  const [open, setOpen] = useState(false)
  const isRunning = event.status === 'running'
  const isError = event.status === 'error'
  const label = useMemo(() => getToolLabel(event.name, event.input), [event.input, event.name])
  const inputPreview = useMemo(() => getInputPreview(event.name, event.input), [event.input, event.name])
  const formattedInput = useMemo(() => formatJson(event.input), [event.input])
  const media = useMemo(() => (event.output ? extractMedia(event.output) : null), [event.output])
  const formattedOutput = useMemo(
    () => (media?.cleanText ? formatToolOutput(event.name, media.cleanText) : ''),
    [event.name, media],
  )
  const color = isError ? '#F43F5E' : isRunning ? '#F59E0B' : '#22C55E'

  const reasoning = event.reasoning?.trim()

  return (
    <div
      className="rounded-[8px] overflow-hidden"
      data-testid="tool-line-row"
      data-tool-name={event.name}
      data-tool-status={event.status}
    >
      {reasoning && (
        <div className="flex items-start gap-2 px-2.5 pt-1.5 pb-1" data-testid="tool-reasoning">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-400/50 shrink-0 mt-0.5">
            <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z" />
            <line x1="9" y1="21" x2="15" y2="21" />
          </svg>
          <span className="text-[12px] leading-[1.5] text-text-3/65 italic min-w-0 break-words">{reasoning}</span>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.04] transition-colors cursor-pointer"
      >
        <span className="text-[10px] font-mono text-text-3/40 shrink-0 w-5 text-right">{index + 1}.</span>
        <span className="shrink-0 flex items-center justify-center w-3.5">
          {isRunning ? (
            <span className="block w-3 h-3 rounded-full border-2 border-current animate-spin" style={{ color, borderTopColor: 'transparent' }} />
          ) : isError ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
        <span className="text-[12px] font-600 shrink-0" style={{ color }}>{label}</span>
        {inputPreview && (
          <span className="text-[12px] font-mono text-text-3/65 truncate min-w-0">{inputPreview}</span>
        )}
        <svg
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          className={`ml-auto shrink-0 text-text-3/50 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-white/[0.05]">
          <div className="text-[10px] font-600 uppercase tracking-[0.08em] text-text-3/45">Input</div>
          <pre className="text-[11px] text-text-2 font-mono whitespace-pre-wrap break-all bg-bg/50 rounded-[8px] px-3 py-2 max-h-[200px] overflow-y-auto">
            {formattedInput}
          </pre>
          {event.output && (
            <>
              <div className="text-[10px] font-600 uppercase tracking-[0.08em] text-text-3/45">{isError ? 'Error' : 'Output'}</div>
              {formattedOutput && (
                <pre className={`text-[11px] font-mono whitespace-pre-wrap break-all rounded-[8px] px-3 py-2 max-h-[260px] overflow-y-auto ${isError ? 'text-rose-200/80 bg-rose-500/[0.06]' : 'text-text-2 bg-bg/50'}`}>
                  {formattedOutput}
                </pre>
              )}
              {media && media.images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={`li-${i}`} src={src} alt={`Output ${i + 1}`} loading="lazy" className="max-w-[360px] rounded-[8px] border border-white/10" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
})

export const ToolLineList = memo(function ToolLineList({ toolEvents }: { toolEvents: ToolEvent[] }) {
  if (toolEvents.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5" data-testid="tool-line-list">
      {toolEvents.map((event, i) => (
        <ToolLineRow key={`line-${event.id}`} event={event} index={i} />
      ))}
    </div>
  )
})
