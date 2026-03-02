'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'default' | 'accent' | 'danger'
  active?: boolean
  size?: 'sm' | 'md'
  tooltip?: string
}

export function IconButton({ children, variant = 'default', active, size = 'md', className = '', tooltip, ...props }: Props) {
  const sizeClass = size === 'sm' ? 'w-8 h-8 rounded-[9px]' : 'w-9 h-9 rounded-[10px]'
  const base = `${sizeClass} border-none bg-transparent flex items-center justify-center cursor-pointer shrink-0 transition-all duration-200 hover:bg-white/[0.06] active:scale-90`
  const color =
    variant === 'accent' ? 'text-accent-bright' :
    variant === 'danger' ? 'text-danger' :
    active ? 'text-accent-bright bg-accent-soft' : 'text-text-3 hover:text-text-2'

  const btn = (
    <button className={`${base} ${color} ${className}`} {...props}>
      {children}
    </button>
  )

  if (!tooltip) return btn

  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[8px] px-2.5 py-1.5 text-[11px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
