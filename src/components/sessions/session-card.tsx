'use client'

import type { Session } from '@/types'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { ConnectorPlatformBadge, getSessionConnector } from '@/components/shared/connector-platform-icon'

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
  const removeSession = useAppStore((s) => s.removeSession)
  const appSettings = useAppStore((s) => s.appSettings)
  const agents = useAppStore((s) => s.agents)
  const connectors = useAppStore((s) => s.connectors)
  const streamingSessionId = useChatStore((s) => s.streamingSessionId)
  const isTyping = streamingSessionId === session.id

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await api('DELETE', `/sessions/${session.id}`)
    removeSession(session.id)
  }

  const last = session.messages?.length
    ? session.messages[session.messages.length - 1]
    : null
  const preview = last
    ? (last.role === 'user' ? 'You: ' : '') + last.text.slice(0, 70)
    : 'No messages'
  const providerLabel = PROVIDER_LABELS[session.provider] || session.provider
  const agent = session.agentId ? agents[session.agentId] : null
  const connector = getSessionConnector(session, connectors)
  const loopIsOngoing = appSettings.loopMode === 'ongoing'
  const intervalRaw = session.heartbeatIntervalSec ?? agent?.heartbeatIntervalSec ?? appSettings.heartbeatIntervalSec ?? 120
  const intervalNum = typeof intervalRaw === 'number' ? intervalRaw : Number.parseInt(String(intervalRaw), 10)
  const intervalEnabled = Number.isFinite(intervalNum) ? intervalNum > 0 : true
  const heartbeatEnabled =
    loopIsOngoing
    && (session.tools?.length ?? 0) > 0
    && intervalEnabled
    && (session.heartbeatEnabled === true || (session.heartbeatEnabled !== false && agent?.heartbeatEnabled !== false))

  return (
    <div
      onClick={onClick}
      className={`group/card relative py-3.5 px-4 cursor-pointer rounded-[14px]
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
        {heartbeatEnabled && (
          <span
            className="inline-flex items-center justify-center w-[10px] h-[10px] rounded-full bg-emerald-400/15 border border-emerald-400/30 shrink-0"
            title="Heartbeat enabled"
          >
            <span className="w-[4px] h-[4px] rounded-full bg-emerald-400" />
          </span>
        )}
        {connector && (
          <ConnectorPlatformBadge
            platform={connector.platform}
            size={16}
            iconSize={9}
            roundedClassName="rounded-[5px]"
            title={`${connector.name} (${connector.platform})`}
          />
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
        <span className="text-[11px] text-text-3/70 shrink-0 tabular-nums font-mono">
          {timeAgo(session.lastActiveAt)}
        </span>
        <button
          onClick={handleDelete}
          className="shrink-0 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150
            text-text-3 hover:text-red-400 p-0.5 -mr-1 cursor-pointer bg-transparent border-none"
          title="Delete session"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="text-[12px] text-text-3/70 font-mono mt-1.5 truncate">
        {shortPath(session.cwd)}
      </div>
      {isTyping ? (
        <div className="text-[13px] text-accent-bright/70 truncate mt-1 leading-relaxed flex items-center gap-1.5">
          <span className="flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:0ms]" />
            <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:150ms]" />
            <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:300ms]" />
          </span>
          Typing...
        </div>
      ) : (
        <div className="text-[13px] text-text-2/50 truncate mt-1 leading-relaxed">{preview}</div>
      )}
    </div>
  )
}
