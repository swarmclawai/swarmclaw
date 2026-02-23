'use client'

import type { MemoryEntry } from '@/types'

function timeAgo(ts: number): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

interface Props {
  entry: MemoryEntry
  active?: boolean
  agentName?: string | null
  onClick: () => void
}

export function MemoryCard({ entry, active, agentName, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      className={`relative py-3 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        ${active
          ? 'bg-primary/10 border border-primary/20 shadow-sm'
          : 'bg-background border border-border hover:bg-muted'}`}
    >
      {active && (
        <div className="absolute left-0 top-3 bottom-3 w-[2.5px] rounded-full bg-primary" />
      )}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[9px] font-700 uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded-[5px]">
          {entry.category || 'note'}
        </span>
        <span className="font-display text-[13px] font-600 truncate flex-1 tracking-[-0.01em] text-foreground">{entry.title}</span>
        <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums font-mono">
          {timeAgo(entry.updatedAt || entry.createdAt)}
        </span>
      </div>
      <div className="text-[12px] text-foreground/80 mt-1 truncate leading-relaxed">
        {entry.content || '(empty)'}
      </div>
      {(entry.references?.length || entry.linkedMemoryIds?.length || entry.image?.path || entry.imagePath) && (
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
          {entry.references?.length ? <span>{entry.references.length} ref{entry.references.length === 1 ? '' : 's'}</span> : null}
          {entry.linkedMemoryIds?.length ? <span>{entry.linkedMemoryIds.length} linked</span> : null}
          {(entry.image?.path || entry.imagePath) ? <span>image</span> : null}
        </div>
      )}
      {agentName && (
        <div className="flex items-center gap-1 mt-1.5">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-muted-foreground">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
          <span className="text-[10px] text-muted-foreground truncate">{agentName}</span>
        </div>
      )}
    </div>
  )
}
