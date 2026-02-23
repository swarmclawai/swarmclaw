'use client'

import type { ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

export function BottomSheet({ open, onClose, children, wide }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className={`relative bg-card w-full ${wide ? 'max-w-[640px]' : 'max-w-[520px]'} max-h-[85vh] flex flex-col
          rounded-[24px] border border-border shadow-xl`}
        style={{ animation: 'modal-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <div className="flex-1 overflow-y-auto px-8 pt-8 pb-8">
          {children}
        </div>
      </div>
    </div>
  )
}
