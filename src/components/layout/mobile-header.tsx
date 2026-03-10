'use client'

import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { IconButton } from '@/components/shared/icon-button'
import { NotificationCenter } from '@/components/shared/notification-center'
import { AgentAvatar } from '@/components/agents/agent-avatar'

export function MobileHeader() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const activeSessionId = useAppStore(selectActiveSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const agents = useAppStore((s) => s.agents)
  const session = activeSessionId ? sessions[activeSessionId] : null
  const agent = session?.agentId ? agents[session.agentId] : null
  const title = agent?.name || session?.name || 'SwarmClaw'
  const subtitle = agent
    ? 'Agent chat'
    : session
      ? 'Direct chat'
      : 'Workspace'

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] bg-bg/80 backdrop-blur-md shrink-0 min-h-[56px]"
      style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}>
      <IconButton onClick={toggleSidebar} aria-label="Toggle sidebar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="7" x2="21" y2="7" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="17" x2="18" y2="17" />
        </svg>
      </IconButton>
      {agent && (
        <AgentAvatar
          seed={agent.avatarSeed || null}
          avatarUrl={agent.avatarUrl}
          name={agent.name}
          size={28}
        />
      )}
      <div className="flex-1 min-w-0">
        <h1 className="font-display text-[14px] font-600 tracking-[-0.02em] truncate">
          {title}
        </h1>
        <p className="text-[10px] text-text-3/60 truncate mt-0.5">
          {subtitle}
        </p>
      </div>
      <NotificationCenter />
    </header>
  )
}
