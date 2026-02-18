'use client'

import type { Session } from '@/types'

function timeAgo(ts: number): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

function shortPath(p: string): string {
  return (p || '').replace(/^\/Users\/\w+/, '~')
}

const PROVIDER_LABELS: Record<string, string> = {
  'claude-cli': '',
  openai: 'GPT',
  ollama: 'OLL',
  anthropic: 'ANT',
}

interface Props {
  session: Session
  active?: boolean
  onClick: () => void
}

export function SessionCard({ session, active, onClick }: Props) {
  const last = session.messages?.length
    ? session.messages[session.messages.length - 1]
    : null
  const preview = last
    ? (last.role === 'user' ? 'You: ' : '') + last.text.slice(0, 70)
    : 'No messages'
  const providerLabel = PROVIDER_LABELS[session.provider] || session.provider

  return (
    <div
      onClick={onClick}
      className={`relative py-3.5 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        ${active
          ? 'bg-accent-soft border border-accent-bright/10'
          : 'bg-transparent border border-transparent hover:bg-white/[0.02] hover:border-white/[0.03]'}`}
    >
      {active && (
        <div className="absolute left-0 top-3.5 bottom-3.5 w-[2.5px] rounded-full bg-accent-bright" />
      )}
      <div className="flex items-center gap-2.5">
        {session.active && (
          <span className="inline-block w-[6px] h-[6px] rounded-full bg-success shrink-0"
            style={{ animation: 'pulse 2s ease-in-out infinite' }} />
        )}
        <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{session.name}</span>
        {session.sessionType === 'orchestrated' && (
          <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-amber-400/80 bg-amber-400/[0.08] px-2 py-0.5 rounded-[6px]">
            AI
          </span>
        )}
        {providerLabel && (
          <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-text-3/70 bg-white/[0.03] px-2 py-0.5 rounded-[6px]">
            {providerLabel}
          </span>
        )}
        <span className="text-[11px] text-text-3/40 shrink-0 tabular-nums font-mono">
          {timeAgo(session.lastActiveAt)}
        </span>
      </div>
      <div className="text-[12px] text-text-3/40 font-mono mt-1.5 truncate">
        {shortPath(session.cwd)}
      </div>
      <div className="text-[13px] text-text-2/50 truncate mt-1 leading-relaxed">{preview}</div>
    </div>
  )
}
