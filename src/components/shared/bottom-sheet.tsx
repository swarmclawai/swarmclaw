'use client'

import type { ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'

interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
  wide?: boolean
  title?: string
  description?: string
}

export function BottomSheet({ open, onClose, children, wide, title, description }: Props) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-100 bg-black/72 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          className={`fixed inset-x-0 bottom-0 z-100 mx-auto flex max-h-[92vh] w-full flex-col bg-raised shadow-[0_24px_80px_rgba(0,0,0,0.6),0_0_1px_rgba(255,255,255,0.05)] outline-none
            rounded-t-[24px] border border-white/[0.06]
            data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom
            sm:inset-x-auto sm:top-[50%] sm:bottom-auto sm:left-[50%] sm:w-[calc(100%-2rem)] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-[24px]
            sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95
            ${wide ? 'sm:max-w-[760px]' : 'sm:max-w-[560px]'}`}
          style={{ animationDuration: '220ms' }}
        >
          <div className="relative shrink-0 px-4 pt-4 pr-14 sm:px-5 sm:pt-6 sm:pr-16">
            <div className="mx-auto h-1 w-10 rounded-full bg-white/[0.08] sm:hidden" />
            <DialogPrimitive.Title className="sr-only">
              {title || 'Dialog'}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="sr-only">
                {description}
              </DialogPrimitive.Description>
            ) : null}
            <DialogPrimitive.Close
              className="absolute right-4 top-3.5 inline-flex h-9 w-9 items-center justify-center rounded-[12px] border border-white/[0.06] bg-white/[0.03] text-text-3 transition-all hover:bg-white/[0.06] hover:text-text-2 focus:outline-none focus:ring-2 focus:ring-accent-bright/30 sm:right-5 sm:top-5"
            >
              <XIcon className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-8 sm:pt-5">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
