'use client'

import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
}

export function Dropdown({ open, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      className="fixed top-12 right-3 bg-raised border border-white/[0.06] rounded-[14px]
        p-1.5 z-90 min-w-[200px] shadow-[0_16px_64px_rgba(0,0,0,0.6)]
        backdrop-blur-xl"
      style={{ animation: 'fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      {children}
    </div>
  )
}

export function DropdownItem({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3.5 py-2.5 border-none bg-transparent text-[13px] font-500
        text-left cursor-pointer rounded-[10px] transition-all duration-150
        hover:bg-white/[0.05] active:bg-white/[0.07]
        ${danger ? 'text-danger' : 'text-text-2 hover:text-text'}`}
      style={{ fontFamily: 'inherit' }}
    >
      {children}
    </button>
  )
}

export function DropdownSep() {
  return <div className="h-px bg-white/[0.04] my-1 mx-2" />
}
