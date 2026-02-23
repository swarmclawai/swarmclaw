'use client'

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
  if (!open) return null

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-card rounded-[20px] p-6 w-full max-w-[380px]
        shadow-[0_24px_80px_rgba(0,0,0,0.5)] border border-border"
        style={{ animation: 'fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <h3 className="font-display text-[18px] font-700 tracking-[-0.02em] mb-2 font-display">{title}</h3>
        <p className="text-[13px] text-muted-foreground mb-6 leading-relaxed">{message}</p>
        <div className="flex gap-2.5">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-[12px] border border-border bg-transparent text-muted-foreground text-[13px] font-600 cursor-pointer
              hover:bg-muted transition-all duration-200"
            style={{ fontFamily: 'inherit' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-2.5 rounded-[12px] border-none text-[13px] font-600 cursor-pointer active:scale-[0.97] transition-all duration-200
              ${danger
                ? 'bg-destructive text-destructive-foreground shadow-[0_4px_20px_rgba(244,63,94,0.2)]'
                : 'bg-primary text-primary-foreground shadow-[0_4px_20px_rgba(249,115,22,0.2)]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
