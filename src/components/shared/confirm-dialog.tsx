'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  confirmDisabled?: boolean
  cancelDisabled?: boolean
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmDisabled = false,
  cancelDisabled = false,
  danger,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !cancelDisabled) onCancel() }}>
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
            <Button
              type="button"
              variant="surface"
              onClick={onCancel}
              disabled={cancelDisabled}
              className="flex-1 px-4 py-2.5 text-[13px]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={danger ? 'destructive' : 'accent'}
              onClick={onConfirm}
              disabled={confirmDisabled}
              className={`flex-1 px-4 py-2.5 text-[13px] active:scale-[0.98]
                ${danger
                  ? 'shadow-[0_4px_20px_rgba(244,63,94,0.2)]'
                  : 'shadow-[0_4px_20px_rgba(99,102,241,0.2)]'}
                disabled:active:scale-100`}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
