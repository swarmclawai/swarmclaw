'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel() }}>
      <DialogContent
        className="sm:max-w-[400px] rounded-[20px] border-white/[0.06] bg-raised p-0 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-2 text-[13px] leading-relaxed text-text-2">
              {message}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-[12px] border border-white/[0.06] bg-transparent px-4 py-2.5 text-[13px] font-600 text-text-2 transition-all duration-200 hover:bg-surface"
              style={{ fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`flex-1 rounded-[12px] border-none px-4 py-2.5 text-[13px] font-600 text-white transition-all duration-200 active:scale-[0.98]
                ${danger
                  ? 'bg-danger shadow-[0_4px_20px_rgba(244,63,94,0.2)]'
                  : 'bg-accent-bright shadow-[0_4px_20px_rgba(99,102,241,0.2)]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {confirmLabel}
            </button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
