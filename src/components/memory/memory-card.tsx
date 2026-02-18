'use client'

import { useState } from 'react'
import type { MemoryEntry } from '@/types'

interface Props {
  entry: MemoryEntry
  onUpdate?: () => void
}

export function MemoryCard({ entry }: Props) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      className="relative py-3.5 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        bg-transparent border border-transparent hover:bg-white/[0.02] hover:border-white/[0.03]"
    >
      <div className="flex items-center gap-2.5">
        <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{entry.title}</span>
        <span className="text-[11px] text-text-3/30 shrink-0 tabular-nums font-mono">
          {new Date(entry.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className={`text-[13px] text-text-2/50 mt-1.5 leading-relaxed ${expanded ? '' : 'truncate'}`}>
        {entry.content}
      </div>
    </div>
  )
}
