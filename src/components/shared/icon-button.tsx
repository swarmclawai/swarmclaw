'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'default' | 'accent' | 'danger'
  active?: boolean
  size?: 'sm' | 'md'
}

export function IconButton({ children, variant = 'default', active, size = 'md', className = '', ...props }: Props) {
  const sizeClass = size === 'sm' ? 'w-8 h-8 rounded-[9px]' : 'w-9 h-9 rounded-[10px]'
  const base = `${sizeClass} border-none bg-transparent flex items-center justify-center cursor-pointer shrink-0 transition-all duration-200 hover:bg-white/[0.06] active:scale-90`
  const color =
    variant === 'accent' ? 'text-accent-bright' :
    variant === 'danger' ? 'text-danger' :
    active ? 'text-accent-bright bg-accent-soft' : 'text-text-3 hover:text-text-2'

  return (
    <button className={`${base} ${color} ${className}`} {...props}>
      {children}
    </button>
  )
}
