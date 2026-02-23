'use client'

import { AiAvatar } from '@/components/shared/avatar'

interface Props {
  assistantName?: string
}

export function ThinkingIndicator({ assistantName }: Props) {
  return (
    <div className="flex flex-col items-start"
      style={{ animation: 'msg-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}>
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <AiAvatar size="sm" />
        <span className="text-[12px] font-600 text-muted-foreground">{assistantName || 'Claude'}</span>
      </div>
      <div className="bubble-ai px-6 py-5">
        <div className="flex gap-2">
          <span className="w-[6px] h-[6px] rounded-full bg-primary/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite' }} />
          <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.15s' }} />
          <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.3s' }} />
        </div>
      </div>
    </div>
  )
}
