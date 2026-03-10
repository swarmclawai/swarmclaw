'use client'

import Link from 'next/link'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { VIEW_DESCRIPTIONS } from '@/lib/app/view-constants'
import { getViewPath } from '@/lib/app/navigation'
import type { AppView } from '@/types'

export function NavItem({ view, label, expanded, isActive, onClick, badge, children }: {
  view: AppView
  label: string
  expanded: boolean
  isActive: boolean
  onClick?: () => void
  badge?: number
  children: React.ReactNode
}) {
  const href = getViewPath(view)

  if (expanded) {
    return (
      <Link
        href={href}
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all border-none no-underline
          ${isActive
            ? 'bg-accent-soft text-accent-bright'
            : 'bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04]'}`}
        style={{ fontFamily: 'inherit' }}
      >
        <span className="shrink-0 relative">
          {children}
          {!!badge && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-0.5">
              {badge}
            </span>
          )}
        </span>
        <span className="truncate" style={{ animation: 'spring-in 0.4s var(--ease-spring)' }}>{label}</span>
      </Link>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={href} onClick={onClick} className={`rail-btn ${isActive ? 'active' : ''} relative no-underline`}>
          {children}
          {!!badge && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-0.5">
              {badge}
            </span>
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[10px] px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-text-3 leading-[1.4]">{VIEW_DESCRIPTIONS[view]}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export function RailTooltip({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[10px] px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-text-3 leading-[1.4]">{description}</div>
      </TooltipContent>
    </Tooltip>
  )
}
