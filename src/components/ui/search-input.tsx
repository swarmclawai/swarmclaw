'use client'

import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const SIZE_CLASSES = {
  sm: 'px-4 py-2.5 rounded-[12px] text-[13px] border-white/[0.04]',
  md: 'px-4 py-3.5 rounded-[14px] text-[15px] border-white/[0.08]',
} as const

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  onClear?: () => void
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput({ size = 'sm', onClear, value, className, ...props }, ref) {
    const hasValue = typeof value === 'string' ? value.length > 0 : !!value

    return (
      <div className={cn('relative', className)}>
        <input
          ref={ref}
          type="text"
          value={value}
          className={cn(
            'w-full border bg-surface text-text outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow',
            SIZE_CLASSES[size],
          )}
          style={{ fontFamily: 'inherit' }}
          {...props}
        />
        {hasValue && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-colors"
            aria-label="Clear search"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    )
  },
)
