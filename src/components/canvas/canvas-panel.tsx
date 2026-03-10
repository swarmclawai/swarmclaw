'use client'

import { useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/app/api-client'
import { normalizeCanvasContent } from '@/lib/canvas-content'
import type { CanvasContent, CanvasDocument } from '@/types'

interface CanvasPanelProps {
  sessionId: string
  agentName?: string
  onClose: () => void
}

const THEME_STYLES: Record<NonNullable<CanvasDocument['theme']>, { accent: string; chip: string }> = {
  slate: { accent: 'text-sky-300', chip: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
  sky: { accent: 'text-sky-300', chip: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
  emerald: { accent: 'text-emerald-300', chip: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
  amber: { accent: 'text-amber-300', chip: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  rose: { accent: 'text-rose-300', chip: 'bg-rose-500/10 text-rose-300 border-rose-500/20' },
}

function toneClass(tone?: string): string {
  switch (tone) {
    case 'positive': return 'text-emerald-300'
    case 'negative': return 'text-rose-300'
    case 'warning': return 'text-amber-300'
    default: return 'text-text'
  }
}

function intentClass(intent?: string): string {
  switch (intent) {
    case 'primary': return 'bg-sky-500 text-white border-sky-400/30'
    case 'success': return 'bg-emerald-500 text-white border-emerald-400/30'
    case 'danger': return 'bg-rose-500 text-white border-rose-400/30'
    default: return 'bg-white/[0.03] text-text-2 border-white/[0.08]'
  }
}

function StructuredCanvasView({ document }: { document: CanvasDocument }) {
  const theme = THEME_STYLES[document.theme || 'slate']
  return (
    <div className="h-full overflow-y-auto bg-bg px-5 py-5">
      <div className="max-w-4xl mx-auto space-y-4">
        {(document.title || document.subtitle) && (
          <div className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4">
            {document.title && <h2 className={`font-display text-[22px] font-700 tracking-[-0.03em] ${theme.accent}`}>{document.title}</h2>}
            {document.subtitle && <p className="mt-1 text-[13px] text-text-3/70">{document.subtitle}</p>}
          </div>
        )}

        {document.blocks.map((block, index) => {
          if (block.type === 'markdown') {
            return (
              <section key={`${block.type}-${index}`} className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4">
                {block.title && <div className={`mb-3 text-[11px] font-700 uppercase tracking-[0.08em] ${theme.accent}`}>{block.title}</div>}
                <div className="max-w-none text-[14px] leading-6 text-text-2/90 [&_h1]:font-display [&_h1]:text-[24px] [&_h1]:text-text [&_h2]:font-display [&_h2]:text-[20px] [&_h2]:text-text [&_h3]:font-display [&_h3]:text-[18px] [&_h3]:text-text [&_p]:my-3 [&_ul]:my-3 [&_ul]:pl-5 [&_li]:my-1 [&_code]:rounded [&_code]:bg-black/[0.2] [&_code]:px-1.5 [&_code]:py-0.5">
                  <ReactMarkdown>{block.markdown}</ReactMarkdown>
                </div>
              </section>
            )
          }

          if (block.type === 'metrics') {
            return (
              <section key={`${block.type}-${index}`} className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4">
                {block.title && <div className={`mb-3 text-[11px] font-700 uppercase tracking-[0.08em] ${theme.accent}`}>{block.title}</div>}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                  {block.items.map((item) => (
                    <div key={item.label} className="rounded-[14px] border border-white/[0.08] bg-black/[0.14] px-4 py-3">
                      <div className="text-[11px] uppercase tracking-[0.08em] text-text-3/60">{item.label}</div>
                      <div className={`mt-1 text-[24px] font-display font-700 tracking-[-0.03em] ${toneClass(item.tone)}`}>{item.value}</div>
                      {item.detail && <div className="mt-1 text-[12px] text-text-3/65">{item.detail}</div>}
                    </div>
                  ))}
                </div>
              </section>
            )
          }

          if (block.type === 'cards') {
            return (
              <section key={`${block.type}-${index}`} className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4">
                {block.title && <div className={`mb-3 text-[11px] font-700 uppercase tracking-[0.08em] ${theme.accent}`}>{block.title}</div>}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {block.items.map((item) => (
                    <div key={item.title} className="rounded-[14px] border border-white/[0.08] bg-black/[0.14] px-4 py-3">
                      <div className={`text-[15px] font-700 ${toneClass(item.tone)}`}>{item.title}</div>
                      {item.body && <p className="mt-2 text-[13px] leading-6 text-text-2/85 whitespace-pre-wrap">{item.body}</p>}
                      {item.meta && <div className="mt-3 text-[11px] text-text-3/60">{item.meta}</div>}
                    </div>
                  ))}
                </div>
              </section>
            )
          }

          if (block.type === 'table') {
            return (
              <section key={`${block.type}-${index}`} className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4 overflow-hidden">
                {block.title && <div className={`mb-3 text-[11px] font-700 uppercase tracking-[0.08em] ${theme.accent}`}>{block.title}</div>}
                <div className="overflow-x-auto rounded-[12px] border border-white/[0.08]">
                  <table className="min-w-full text-left text-[13px]">
                    <thead className="bg-black/[0.18]">
                      <tr>
                        {block.table.columns.map((column) => (
                          <th key={column} className="px-3 py-2.5 font-700 text-text-2">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.table.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-t border-white/[0.06]">
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex} className="px-3 py-2.5 text-text-3/80">{cell == null ? '—' : String(cell)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {block.table.caption && <div className="mt-2 text-[11px] text-text-3/60">{block.table.caption}</div>}
              </section>
            )
          }

          if (block.type === 'code') {
            return (
              <section key={`${block.type}-${index}`} className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4">
                {block.title && <div className={`mb-3 text-[11px] font-700 uppercase tracking-[0.08em] ${theme.accent}`}>{block.title}</div>}
                <pre className="overflow-x-auto rounded-[14px] border border-white/[0.08] bg-black/[0.25] p-4 text-[12px] leading-6 text-text-2">
                  <code>{block.code}</code>
                </pre>
                {block.language && <div className={`mt-2 inline-flex rounded-full border px-2 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${theme.chip}`}>{block.language}</div>}
              </section>
            )
          }

          if (block.type === 'actions') {
            return (
              <section key={`${block.type}-${index}`} className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-5 py-4">
                {block.title && <div className={`mb-3 text-[11px] font-700 uppercase tracking-[0.08em] ${theme.accent}`}>{block.title}</div>}
                <div className="flex flex-wrap gap-2">
                  {block.items.map((item) => (
                    item.href ? (
                      <a
                        key={item.label}
                        href={item.href}
                        target="_blank"
                        rel="noreferrer"
                        className={`inline-flex items-center rounded-[12px] border px-3 py-2 text-[12px] font-700 transition-all hover:brightness-110 ${intentClass(item.intent)}`}
                      >
                        {item.label}
                      </a>
                    ) : (
                      <div key={item.label} className={`inline-flex items-center rounded-[12px] border px-3 py-2 text-[12px] font-700 ${intentClass(item.intent)}`}>
                        {item.label}
                      </div>
                    )
                  ))}
                </div>
                {block.items.some((item) => item.note) && (
                  <div className="mt-3 space-y-1">
                    {block.items.filter((item) => item.note).map((item) => (
                      <div key={`${item.label}-note`} className="text-[11px] text-text-3/60">{item.label}: {item.note}</div>
                    ))}
                  </div>
                )}
              </section>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}

export function CanvasPanel({ sessionId, agentName, onClose }: CanvasPanelProps) {
  const [content, setContent] = useState<CanvasContent>(null)
  const [loaded, setLoaded] = useState(false)

  const loadCanvas = useCallback(async () => {
    try {
      const res = await api<{ content: CanvasContent }>('GET', `/canvas/${sessionId}`)
      setContent(normalizeCanvasContent(res.content))
    } catch {
      setContent(null)
    } finally {
      setLoaded(true)
    }
  }, [sessionId])

  useEffect(() => { loadCanvas() }, [loadCanvas])
  useWs(`canvas:${sessionId}`, loadCanvas, 10_000)

  const header = (
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
  )

  if (!loaded) {
    return (
      <div className="flex flex-col h-full border-l border-white/[0.06] bg-bg min-w-[400px]">
        {header}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 rounded-full border-2 border-text-3/20 border-t-accent-bright animate-spin mx-auto mb-3" />
            <span className="text-[13px] text-text-3">Loading canvas...</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full border-l border-white/[0.06] bg-bg min-w-[400px]">
      {header}
      <div className="flex-1 overflow-hidden">
        {!content ? (
          <div className="h-full flex items-center justify-center text-center px-6">
            <div>
              <div className="text-[14px] font-600 text-text-2">No canvas content yet</div>
              <p className="mt-1 text-[12px] text-text-3/60">Agents can present HTML or structured documents here.</p>
            </div>
          </div>
        ) : typeof content === 'string' ? (
          <iframe
            sandbox="allow-scripts allow-same-origin"
            srcDoc={content}
            className="w-full h-full border-none bg-white"
            title="Agent Canvas"
          />
        ) : (
          <StructuredCanvasView document={content} />
        )}
      </div>
    </div>
  )
}
