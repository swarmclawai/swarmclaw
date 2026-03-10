'use client'

import type { MemoryEntry } from '@/types'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { deriveMemoryScope, getMemoryScopeLabel, getMemoryTier } from '@/lib/memory-presentation'
import { timeAgoShort } from '@/lib/time-format'

interface Props {
  entry: MemoryEntry
  active?: boolean
  agentName?: string | null
  agentAvatarSeed?: string | null
  agentAvatarUrl?: string | null
  onClick: () => void
}

export function MemoryCard({ entry, active, agentName, agentAvatarSeed, agentAvatarUrl, onClick }: Props) {
  const scope = deriveMemoryScope(entry)
  const tier = getMemoryTier(entry)

  return (
    <div
      onClick={onClick}
      className={`relative py-3 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        ${active
          ? 'bg-accent-soft border border-accent-bright/10'
          : 'bg-transparent border border-transparent hover:bg-white/[0.02] hover:border-white/[0.03]'}`}
    >
      {active && (
        <div className="absolute left-0 top-3 bottom-3 w-[2.5px] rounded-full bg-accent-bright" />
      )}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[9px] font-700 uppercase tracking-wider text-accent-bright/70 bg-accent-soft px-1.5 py-0.5 rounded-[5px]">
          {entry.category || 'note'}
        </span>
        {entry.pinned && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-amber-400/80">
            <path d="M16 2l-4 4-4-4-2 2 4 4-5 5v1h1l5-5 4 4 2-2-4-4 4-4z" transform="rotate(45 12 12)" />
          </svg>
        )}
        <span className="font-display text-[13px] font-600 truncate flex-1 tracking-[-0.01em]">{entry.title}</span>
        <span className="text-[10px] text-text-3/60 shrink-0 tabular-nums font-mono">
          {timeAgoShort(entry.updatedAt || entry.createdAt, Date.now())}
        </span>
      </div>
      <div className="text-[12px] text-text-2/40 mt-1 line-clamp-3 leading-relaxed">
        {entry.content || '(empty)'}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded-[5px] text-[9px] font-700 uppercase tracking-[0.08em] bg-white/[0.04] text-text-3/75">
          {getMemoryScopeLabel(scope)}
        </span>
        <span className={`px-1.5 py-0.5 rounded-[5px] text-[9px] font-700 uppercase tracking-[0.08em] ${
          tier === 'working'
            ? 'bg-amber-400/10 text-amber-300'
            : tier === 'archive'
              ? 'bg-sky-400/10 text-sky-300'
              : 'bg-emerald-400/10 text-emerald-300'
        }`}>
          {tier}
        </span>
      </div>
      {(entry.image?.path || entry.imagePath) && (
        <div className="mt-2 w-10 h-10 rounded-[6px] overflow-hidden bg-white/[0.04] shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={
              (entry.image?.path || entry.imagePath || '').startsWith('data/memory-images/')
                ? `/api/memory-images/${(entry.image?.path || entry.imagePath || '').split('/').pop()}`
                : (entry.image?.path || entry.imagePath || '')
            }
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      )}
      {(entry.references?.length || entry.linkedMemoryIds?.length || entry.image?.path || entry.imagePath) && (
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-text-3/35">
          {entry.references?.length ? <span>{entry.references.length} ref{entry.references.length === 1 ? '' : 's'}</span> : null}
          {entry.linkedMemoryIds?.length ? <span>{entry.linkedMemoryIds.length} linked</span> : null}
          {(entry.image?.path || entry.imagePath) ? <span>image</span> : null}
        </div>
      )}
      {agentName ? (
        <div className="flex items-center gap-1.5 mt-1.5">
          <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={16} />
          <span className="text-[10px] text-text-3/60 truncate">{agentName}</span>
        </div>
      ) : !entry.agentId ? (
        <div className="flex items-center gap-1 mt-1.5">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/50">
            <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="text-[10px] text-text-3/50">Global</span>
        </div>
      ) : null}
    </div>
  )
}
