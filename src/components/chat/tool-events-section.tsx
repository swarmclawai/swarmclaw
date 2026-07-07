'use client'

import { memo, useCallback, useMemo, useState } from 'react'
import { extractMedia, getToolLabel, isExplicitScreenshot } from './tool-call-bubble'
import { ToolLineList } from './tool-line-list'
import type { ToolEvent } from '@/stores/use-chat-store'

/* ── Shared summary helper ─────────────────────────────── */
function computeToolSummary(toolEvents: ToolEvent[]) {
  let running = 0
  let done = 0
  let error = 0
  for (const event of toolEvents) {
    if (event.status === 'running') running += 1
    else if (event.status === 'error') error += 1
    else done += 1
  }
  return { total: toolEvents.length, running, done, error }
}

/* ── Inline pill shown in the sender row ───────────────── */
export const ToolActivityPill = memo(function ToolActivityPill({
  toolEvents,
  isOpen,
  onToggle,
}: {
  toolEvents: ToolEvent[]
  isOpen: boolean
  onToggle: () => void
}) {
  const summary = useMemo(() => computeToolSummary(toolEvents), [toolEvents])

  const lastRunning = useMemo(() => {
    for (let i = toolEvents.length - 1; i >= 0; i--) {
      if (toolEvents[i].status === 'running') return toolEvents[i]
    }
    return null
  }, [toolEvents])

  const hasErrors = summary.error > 0
  const isRunning = summary.running > 0

  // Pill label
  const label = useMemo(() => {
    if (isRunning && lastRunning) {
      return `Using ${getToolLabel(lastRunning.name, lastRunning.input)}...`
    }
    if (summary.total === 1) {
      const ev = toolEvents[0]
      const base = getToolLabel(ev.name, ev.input)
      return hasErrors ? `${base} (failed)` : base
    }
    return hasErrors
      ? `${summary.total} tools (${summary.error} failed)`
      : `${summary.total} tools`
  }, [isRunning, lastRunning, summary.total, summary.error, hasErrors, toolEvents])

  // Pill color reflects the majority outcome: if most tools succeeded, show
  // green even if a few failed. Only show red when errors are the majority.
  const mostlyFailed = summary.error > summary.done

  const pillClass = isRunning
    ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
    : mostlyFailed
      ? 'border-rose-500/20 bg-rose-500/10 text-rose-300'
      : 'border-white/[0.08] bg-white/[0.04] text-text-3/70'

  const dotClass = isRunning
    ? 'bg-amber-400'
    : mostlyFailed
      ? 'bg-rose-400'
      : 'bg-emerald-400'

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-600 cursor-pointer transition-colors hover:brightness-125 ${pillClass}`}
      data-testid="tool-activity-pill"
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}
        style={isRunning ? { animation: 'pulse 1.5s ease infinite' } : undefined}
      />
      <span className="truncate max-w-[140px]">{label}</span>
      <svg
        width="8"
        height="8"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        className={`shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  )
})

export function collectCollapsedMedia(toolEvents: ToolEvent[], opts?: { expanded?: boolean; showCollapsedMedia?: boolean }) {
  if (opts?.expanded || opts?.showCollapsedMedia === false) return null
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
}

export const ToolEventsSection = memo(function ToolEventsSection({
  toolEvents,
  showCollapsedMedia = false,
  controlled,
}: {
  toolEvents: ToolEvent[]
  showCollapsedMedia?: boolean
  /** When provided, the section renders only the body (no outer wrapper/header). The parent owns open/close. */
  controlled?: boolean
}) {
  const [sectionOpen, setSectionOpen] = useState(false)
  const [userToggled, setUserToggled] = useState(false)

  const summary = useMemo(() => computeToolSummary(toolEvents), [toolEvents])

  // Derive effective open state instead of setState during render
  const effectiveSectionOpen = controlled ? sectionOpen : (sectionOpen || (!userToggled && summary.running > 0))

  const handleSectionToggle = useCallback(() => {
    setUserToggled(true)
    setSectionOpen((v) => !v)
  }, [])

  const collapsedMedia = useMemo(() => {
    return collectCollapsedMedia(toolEvents, { showCollapsedMedia })
  }, [showCollapsedMedia, toolEvents])

  /* ── Shared expanded body ─────────────────────────── */
  const bodyContent = (
    <div className="px-4 py-3.5">
      {/* Every tool the agent used — click a row to expand its full input/output */}
      <div>
        <div className="text-[10px] font-600 uppercase tracking-[0.08em] text-text-3/45 px-2.5 mb-1">
          {summary.total === 1 ? 'Step detail' : `All steps (${summary.total})`}
        </div>
        <ToolLineList toolEvents={toolEvents} />
      </div>

      {summary.running > 0 && (
        <div className="mt-2 px-2.5 text-[11px] text-text-3/55">
          Updates stream here without reflowing the whole thread
        </div>
      )}

      {collapsedMedia && (
        <div className="mt-3 flex flex-col gap-2">
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

    </div>
  )

  /* ── Controlled mode: body only, parent provides chrome ── */
  if (controlled) {
    return bodyContent
  }

  /* ── Uncontrolled mode: full standalone card (legacy) ─── */
  return (
    <div className="max-w-[85%] md:max-w-[72%] mb-2" data-testid="tool-activity">
      <div className="rounded-[16px] border border-white/[0.08] bg-surface/72 backdrop-blur-sm overflow-hidden">
        {/* Compact header — always visible */}
        <button
          type="button"
          onClick={handleSectionToggle}
          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
          data-testid="tool-activity-section-toggle"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className={`shrink-0 text-text-3/55 transition-transform ${effectiveSectionOpen ? 'rotate-90' : ''}`}
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className="text-[11px] font-600 uppercase tracking-[0.08em] text-text-3/55">
            Tool Activity
          </span>
          <span className="text-[12px] text-text-3/50">
            {summary.total} call{summary.total === 1 ? '' : 's'}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
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
        </button>

        {/* Expanded body */}
        {effectiveSectionOpen && (
          <div className="border-t border-white/[0.06]">
            {bodyContent}
          </div>
        )}
      </div>
    </div>
  )
})
