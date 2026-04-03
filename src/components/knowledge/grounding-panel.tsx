'use client'

import type { KnowledgeCitation, KnowledgeRetrievalTrace } from '@/types'

function dedupeCitations(citations: KnowledgeCitation[]): KnowledgeCitation[] {
  const seen = new Set<string>()
  const out: KnowledgeCitation[] = []
  for (const citation of citations) {
    const key = `${citation.sourceId}:${citation.chunkId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(citation)
  }
  return out
}

export function GroundingPanel(props: {
  citations?: KnowledgeCitation[]
  retrievalTrace?: KnowledgeRetrievalTrace | null
  title?: string
  compact?: boolean
  className?: string
}) {
  const explicit = Array.isArray(props.citations) ? dedupeCitations(props.citations) : []
  const fallback = props.retrievalTrace?.hits ? dedupeCitations(props.retrievalTrace.hits) : []
  const items = explicit.length > 0 ? explicit : fallback
  if (items.length === 0) return null

  const title = props.title || 'Grounding'
  const compact = props.compact === true
  const selected = explicit.length > 0

  return (
    <details className={`group rounded-[12px] border border-sky-400/15 bg-sky-400/[0.04] ${props.className || ''}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 select-none [&::-webkit-details-marker]:hidden">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-sky-300/70 transition-transform group-open:rotate-90">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-[11px] font-600 uppercase tracking-[0.05em] text-sky-200/80">{title}</span>
        <span className="text-[10px] font-mono text-text-3/50">
          {selected ? `${explicit.length} citation${explicit.length === 1 ? '' : 's'}` : `${fallback.length} retrieved`}
        </span>
        {props.retrievalTrace?.selectorStatus && (
          <span className="ml-auto text-[10px] text-text-3/45">
            {props.retrievalTrace.selectorStatus === 'selected'
              ? 'selected'
              : props.retrievalTrace.selectorStatus === 'no_match'
                ? 'candidates'
                : 'retrieved'}
          </span>
        )}
      </summary>

      <div className="space-y-2 px-3.5 pb-3 pt-1">
        {props.retrievalTrace?.query && (
          <div className="rounded-[10px] border border-white/[0.06] bg-black/20 px-3 py-2 text-[11px] text-text-3/75">
            Query: <span className="text-text-2">{props.retrievalTrace.query}</span>
          </div>
        )}

        {items.map((citation) => (
          <div key={`${citation.sourceId}:${citation.chunkId}`} className="rounded-[10px] border border-white/[0.06] bg-black/15 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-600 text-text-2">{citation.sourceTitle}</div>
                <div className="mt-0.5 text-[10px] text-text-3/60">
                  Chunk {citation.chunkIndex + 1} of {citation.chunkCount}
                  {citation.sectionLabel ? ` • ${citation.sectionLabel}` : ''}
                </div>
              </div>
              <div className="shrink-0 text-[10px] font-mono text-text-3/55">
                {citation.score.toFixed(2)}
              </div>
            </div>

            {citation.whyMatched && (
              <div className="mt-2 text-[11px] text-sky-100/78">{citation.whyMatched}</div>
            )}

            <div className={`mt-2 whitespace-pre-wrap break-words text-text-2/85 ${compact ? 'text-[11px]' : 'text-[12px]'}`}>
              {citation.snippet}
            </div>

            {(citation.sourceLabel || citation.sourceUrl) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-text-3/55">
                {citation.sourceLabel && <span>{citation.sourceLabel}</span>}
                {citation.sourceUrl && (
                  <a href={citation.sourceUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                    open source
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}
