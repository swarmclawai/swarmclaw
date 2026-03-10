'use client'

import type { ReactNode } from 'react'
import { useAppStore } from '@/stores/use-app-store'

interface SidebarPanelShellProps {
  title: string
  createLabel?: string
  onNew?: () => void
  headerContent?: ReactNode
  children: ReactNode
}

export function SidebarPanelShell({ title, createLabel, onNew, headerContent, children }: SidebarPanelShellProps) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)

  if (!sidebarOpen) return null

  return (
    <div
      className="w-[280px] shrink-0 bg-raised border-r border-white/[0.04] flex flex-col h-full min-h-0 overflow-hidden touch-pan-y"
      style={{ animation: 'panel-in 0.3s var(--ease-spring)' }}
    >
      <div className="flex items-center px-5 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">{title}</h2>
        {onNew && createLabel && (
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {createLabel}
          </button>
        )}
      </div>
      {headerContent}
      {children}
    </div>
  )
}
