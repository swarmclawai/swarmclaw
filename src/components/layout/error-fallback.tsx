'use client'

type ErrorFallbackProps = {
  title?: string
  message?: string
  primaryLabel?: string
  onPrimaryAction?: () => void
  secondaryLabel?: string
  onSecondaryAction?: () => void
}

export function ErrorFallback({
  title = 'Something went wrong',
  message = 'An unexpected error occurred. Try again or reload the page.',
  primaryLabel = 'Reload',
  onPrimaryAction,
  secondaryLabel,
  onSecondaryAction,
}: ErrorFallbackProps) {
  return (
    <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center bg-bg px-8">
      <div className="max-w-[420px] text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-[16px] border border-red-500/20 bg-red-500/10">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-red-400">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 className="mb-2 font-display text-[22px] font-700 tracking-[-0.02em] text-text">
          {title}
        </h2>
        <p className="mb-6 text-[14px] text-text-3">
          {message}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={onPrimaryAction}
            className="inline-flex cursor-pointer items-center gap-2 rounded-[12px] border-none bg-accent-bright px-6 py-3 text-[14px] font-600 text-white shadow-[0_4px_16px_rgba(99,102,241,0.2)] transition-all hover:brightness-110 active:scale-[0.97]"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {primaryLabel}
          </button>
          {secondaryLabel && onSecondaryAction ? (
            <button
              onClick={onSecondaryAction}
              className="inline-flex cursor-pointer items-center rounded-[12px] border border-border bg-transparent px-5 py-3 text-[14px] font-600 text-text transition-colors hover:bg-panel/60"
              style={{ fontFamily: 'inherit' }}
            >
              {secondaryLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
