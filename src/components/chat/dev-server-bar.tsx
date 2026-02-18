'use client'

import type { DevServerStatus } from '@/types'

interface Props {
  status: DevServerStatus | null
  onStop: () => void
}

export function DevServerBar({ status, onStop }: Props) {
  if (!status) return null

  return (
    <div className="flex items-center gap-2.5 px-4 py-2 bg-success/[0.04] border-b border-white/[0.04] shrink-0">
      <span className="w-[5px] h-[5px] rounded-full bg-success shrink-0"
        style={{ animation: 'pulse 2s ease infinite' }} />
      {status.url ? (
        <a
          href={status.url}
          target="_blank"
          rel="noreferrer"
          className="text-success font-mono text-[11px] flex-1 no-underline hover:underline"
        >
          {status.url}
        </a>
      ) : (
        <span className="text-success font-mono text-[11px] flex-1">Starting...</span>
      )}
      <button
        onClick={onStop}
        className="px-2.5 py-1 rounded-[8px] border border-danger/15 bg-transparent
          text-danger text-[11px] font-600 cursor-pointer hover:bg-danger-soft transition-all duration-200"
        style={{ fontFamily: 'inherit' }}
      >
        Stop
      </button>
    </div>
  )
}
