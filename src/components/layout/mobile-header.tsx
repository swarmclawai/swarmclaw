'use client'

import { useAppStore } from '@/stores/use-app-store'
import { IconButton } from '@/components/shared/icon-button'

export function MobileHeader() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const session = currentSessionId ? sessions[currentSessionId] : null

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-background shrink-0 min-h-[48px]"
      style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}>
      <IconButton onClick={toggleSidebar}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="7" x2="21" y2="7" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="17" x2="18" y2="17" />
        </svg>
      </IconButton>
      <div className="flex items-center gap-2.5 flex-1 min-w-0">
        <div className="w-7 h-7 rounded-[8px] bg-primary flex items-center justify-center shrink-0 shadow-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
            <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95( 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
          </svg>
        </div>
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-display text-[8px] font-800 tracking-[0.15em] text-muted-foreground/50 uppercase whitespace-nowrap">
            Agent
          </span>
          <span className="font-display text-[14px] font-900 tracking-[-0.03em] text-foreground leading-none whitespace-nowrap">
            EMBER
          </span>
        </div>
      </div>
    </header>
  )
}
