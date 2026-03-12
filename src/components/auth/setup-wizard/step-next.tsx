'use client'

import type { StepNextProps } from './types'
import { StepShell } from './shared'

export function StepNext({
  onAddProvider,
  onAddAgent,
  onContinueToDashboard,
}: StepNextProps) {
  return (
    <StepShell>
      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
        What&apos;s Next?
      </h1>
      <p className="text-[15px] text-text-2 mb-8">
        Your agents are saved. You can keep building or head to the dashboard.
      </p>

      <div className="flex flex-col gap-3 max-w-[480px] mx-auto mb-8">
        <button
          onClick={onAddProvider}
          className="w-full px-5 py-4 rounded-[14px] border border-white/[0.08] bg-surface text-left
            transition-all duration-200 flex items-start gap-4 cursor-pointer
            hover:border-accent-bright/30 hover:bg-surface-hover"
        >
          <div className="w-10 h-10 rounded-[10px] border border-white/[0.06] bg-white/[0.04] flex items-center justify-center shrink-0 mt-0.5">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-accent-bright">
              <path d="M9 3V15M3 9H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="text-[15px] font-display font-600 text-text mb-1">Add Another Provider</div>
            <div className="text-[13px] text-text-3 leading-relaxed">
              Connect a different LLM provider for more model options.
            </div>
          </div>
        </button>

        <button
          onClick={onAddAgent}
          className="w-full px-5 py-4 rounded-[14px] border border-white/[0.08] bg-surface text-left
            transition-all duration-200 flex items-start gap-4 cursor-pointer
            hover:border-accent-bright/30 hover:bg-surface-hover"
        >
          <div className="w-10 h-10 rounded-[10px] border border-white/[0.06] bg-white/[0.04] flex items-center justify-center shrink-0 mt-0.5">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-accent-bright">
              <circle cx="9" cy="6" r="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M3 15C3 12.2386 5.68629 10 9 10C12.3137 10 15 12.2386 15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="text-[15px] font-display font-600 text-text mb-1">Add Another Agent</div>
            <div className="text-[13px] text-text-3 leading-relaxed">
              Create another agent using your connected providers.
            </div>
          </div>
        </button>
      </div>

      <button
        onClick={onContinueToDashboard}
        className="px-10 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
          cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
          shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
      >
        Continue to Dashboard
      </button>
    </StepShell>
  )
}
