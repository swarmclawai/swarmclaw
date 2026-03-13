'use client'

import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

interface Props {
  open: boolean
  onToggle: () => void
  summary?: string | null
  badges?: string[]
  children: ReactNode
}

export function AdvancedSettingsSection({ open, onToggle, summary, badges = [], children }: Props) {
  return (
    <section className="mb-8 rounded-[20px] border border-white/[0.06] bg-surface/70">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-4 rounded-[20px] bg-transparent px-5 py-5 text-left transition-all hover:bg-white/[0.02] sm:px-6"
        style={{ fontFamily: 'inherit' }}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-[17px] font-700 tracking-[-0.02em] text-text">Advanced Settings</h3>
            {summary && (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3">
                {summary}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-[1.6] text-text-3/75">
            Power-user controls for routing, runtime behavior, and expert overrides.
          </p>
          {badges.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {badges.slice(0, 5).map((badge) => (
                <span
                  key={badge}
                  className="rounded-[9px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-600 text-text-3"
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-white/[0.06] bg-white/[0.03] text-text-3">
          <ChevronDown className={`size-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="border-t border-white/[0.04] px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
          {children}
        </div>
      )}
    </section>
  )
}
