'use client'

import { useAppStore } from '@/stores/use-app-store'
import { IconButton } from '@/components/shared/icon-button'

export function MobileHeader() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const session = currentSessionId ? sessions[currentSessionId] : null

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] bg-bg/80 backdrop-blur-md shrink-0 min-h-[48px]"
      style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}>
      <IconButton onClick={toggleSidebar}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="7" x2="21" y2="7" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="17" x2="18" y2="17" />
        </svg>
      </IconButton>
      <h1 className="font-display text-[14px] font-600 tracking-[-0.02em] flex-1 truncate">
        {session ? (
          <span className="block truncate">{session.name}</span>
        ) : (
          <span className="font-700">SwarmClaw</span>
        )}
      </h1>
    </header>
  )
}
