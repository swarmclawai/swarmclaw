'use client'

import { memo, useMemo, useState } from 'react'
import { ToolCallBubble, extractMedia, getInputPreview, getToolLabel, isExplicitScreenshot } from './tool-call-bubble'
import type { ToolEvent } from '@/stores/use-chat-store'

function summarizeToolResult(event: ToolEvent): string | null {
  if (!event.output) return null

  const media = extractMedia(event.output)
  const parts: string[] = []

  if (media.images.length > 0) parts.push(`${media.images.length} image${media.images.length === 1 ? '' : 's'}`)
  if (media.videos.length > 0) parts.push(`${media.videos.length} video${media.videos.length === 1 ? '' : 's'}`)
  if (media.pdfs.length > 0) parts.push(`${media.pdfs.length} PDF${media.pdfs.length === 1 ? '' : 's'}`)
  if (media.files.length > 0) parts.push(`${media.files.length} file${media.files.length === 1 ? '' : 's'}`)
  if (parts.length > 0) return parts.join(' · ')

  const clean = media.cleanText.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean
}

const ToolStatusPill = memo(function ToolStatusPill({ status }: { status: ToolEvent['status'] }) {
  const tone = status === 'running'
    ? 'border-white/[0.08] bg-white/[0.05] text-text-3'
    : status === 'error'
      ? 'border-rose-500/25 bg-rose-500/10 text-rose-300'
      : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'

  const label = status === 'running' ? 'Running' : status === 'error' ? 'Failed' : 'Done'

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-600 uppercase tracking-[0.08em] ${tone}`}>
      {label}
    </span>
  )
})

const ToolSummaryRow = memo(function ToolSummaryRow({ event, caption }: { event: ToolEvent; caption: string }) {
  const isRunning = event.status === 'running'
  const isError = event.status === 'error'
  const label = useMemo(() => getToolLabel(event.name, event.input), [event.input, event.name])
  const inputPreview = useMemo(() => getInputPreview(event.name, event.input), [event.input, event.name])
  const resultPreview = useMemo(() => summarizeToolResult(event), [event])
  const color = isError ? '#F43F5E' : isRunning ? '#F59E0B' : '#22C55E'

  return (
    <div
      className={`rounded-[14px] border px-3.5 py-3 ${
      isRunning
        ? 'border-amber-500/20 bg-amber-500/[0.06]'
        : isError
          ? 'border-rose-500/18 bg-rose-500/[0.05]'
          : 'border-white/[0.06] bg-white/[0.03]'
    }`}
      data-testid="tool-call-row"
      data-tool-name={event.name}
      data-tool-status={event.status}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {isRunning ? (
            <span className="block w-3.5 h-3.5 rounded-full border-2 border-current animate-spin" style={{ color, borderTopColor: 'transparent' }} />
          ) : isError ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-600 uppercase tracking-[0.08em] text-text-3/55">{caption}</span>
            <span className="text-[13px] font-600 text-text-2">{label}</span>
            <ToolStatusPill status={event.status} />
          </div>
          {inputPreview && (
            <div className="mt-1 text-[12px] font-mono text-text-2 truncate">
              {inputPreview}
            </div>
          )}
          {resultPreview && !isRunning && (
            <div className={`mt-1 text-[12px] ${isError ? 'text-rose-200/80' : 'text-text-3/70'}`}>
              {resultPreview}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export const ToolEventsSection = memo(function ToolEventsSection({ toolEvents }: { toolEvents: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => {
    let running = 0
    let done = 0
    let error = 0
    for (const event of toolEvents) {
      if (event.status === 'running') running += 1
      else if (event.status === 'error') error += 1
      else done += 1
    }
    return { total: toolEvents.length, running, done, error }
  }, [toolEvents])

  const spotlightEvent = useMemo(() => {
    for (let i = toolEvents.length - 1; i >= 0; i--) {
      if (toolEvents[i].status === 'running') return toolEvents[i]
    }
    return toolEvents[toolEvents.length - 1] || null
  }, [toolEvents])

  const secondaryEvents = useMemo(() => {
    if (!spotlightEvent) return []
    return toolEvents
      .filter((event) => event.id !== spotlightEvent.id)
      .slice(-2)
      .reverse()
  }, [spotlightEvent, toolEvents])

  const collapsedMedia = useMemo(() => {
    if (expanded) return null
    const seen = new Set<string>()
    const images: string[] = []
    const videos: string[] = []
    const pdfs: { name: string; url: string }[] = []
    const files: { name: string; url: string }[] = []
    for (const ev of toolEvents) {
      if (!ev.output) continue
      if (!isExplicitScreenshot(ev.name, ev.input)) continue
      const media = extractMedia(ev.output)
      for (const url of media.images) { if (!seen.has(url)) { seen.add(url); images.push(url) } }
      for (const url of media.videos) { if (!seen.has(url)) { seen.add(url); videos.push(url) } }
      for (const pdf of media.pdfs) { if (!seen.has(pdf.url)) { seen.add(pdf.url); pdfs.push(pdf) } }
      for (const file of media.files) { if (!seen.has(file.url)) { seen.add(file.url); files.push(file) } }
    }
    if (!images.length && !videos.length && !pdfs.length && !files.length) return null
    return { images, videos, pdfs, files }
  }, [expanded, toolEvents])

  return (
    <div className="max-w-[85%] md:max-w-[72%] mb-2" data-testid="tool-activity">
      <div className="rounded-[16px] border border-white/[0.08] bg-surface/72 backdrop-blur-sm overflow-hidden">
        <div className="px-4 py-3.5">
          <div className="flex flex-wrap items-start gap-3 justify-between">
            <div>
              <div className="text-[11px] font-600 uppercase tracking-[0.08em] text-text-3/55">
                Tool Activity
              </div>
              <div className="mt-1 text-[13px] text-text-2">
                {summary.total} call{summary.total === 1 ? '' : 's'} in this response
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {summary.running > 0 && (
                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-600 uppercase tracking-[0.08em] text-amber-300">
                  {summary.running} running
                </span>
              )}
              {summary.done > 0 && (
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-600 uppercase tracking-[0.08em] text-emerald-300">
                  {summary.done} done
                </span>
              )}
              {summary.error > 0 && (
                <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-600 uppercase tracking-[0.08em] text-rose-300">
                  {summary.error} failed
                </span>
              )}
            </div>
          </div>

          {spotlightEvent && (
            <div className="mt-3">
              <ToolSummaryRow
                event={spotlightEvent}
                caption={spotlightEvent.status === 'running' ? 'Current step' : 'Latest step'}
              />
            </div>
          )}

          {secondaryEvents.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {secondaryEvents.map((event) => (
                <ToolSummaryRow key={`summary-${event.id}`} event={event} caption="Recent step" />
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              data-testid="tool-activity-toggle"
              className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] font-600 text-text-2 hover:bg-white/[0.06] cursor-pointer transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
              {expanded ? 'Hide call details' : `View ${summary.total === 1 ? 'call' : `${summary.total} calls`} details`}
            </button>
            {summary.running > 0 && (
              <span className="text-[11px] text-text-3/55">
                Updates stream here without reflowing the whole thread
              </span>
            )}
          </div>
        </div>

        {collapsedMedia && (
          <div className="px-4 pb-4 flex flex-col gap-2">
            {collapsedMedia.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`ci-${i}`}
                src={src}
                alt={`Screenshot ${i + 1}`}
                loading="lazy"
                className="max-w-[400px] rounded-[10px] border border-white/10"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ))}
            {collapsedMedia.videos.map((src, i) => (
              <video key={`cv-${i}`} src={src} controls playsInline preload="none" className="max-w-full rounded-[10px] border border-white/10" />
            ))}
            {collapsedMedia.pdfs.map((file, i) => (
              <div key={`cp-${i}`} className="rounded-[10px] border border-white/10 overflow-hidden">
                <iframe src={file.url} loading="lazy" className="w-full h-[400px] bg-white" title={file.name} />
              </div>
            ))}
            {collapsedMedia.files.map((file, i) => (
              <a key={`cf-${i}`} href={file.url} download className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/10 bg-surface/60 text-[13px] text-text-2 no-underline">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {file.name}
              </a>
            ))}
          </div>
        )}

        {expanded && (
          <div className="border-t border-white/[0.06] px-3.5 pb-3 pt-3 flex flex-col gap-2">
            {toolEvents.map((event) => (
              <ToolCallBubble key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
