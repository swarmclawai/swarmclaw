import { STEP_ORDER } from './types'

const STEP_LABELS: Record<string, string> = {
  profile: 'You',
  providers: 'Providers',
  agents: 'Agents',
}

export function StepProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {Array.from({ length: total }, (_, i) => {
        const completed = i < current
        const active = i === current
        const label = STEP_LABELS[STEP_ORDER[i]] || `${i + 1}`
        return (
          <div key={i} className="flex items-center">
            {i > 0 && (
              <div
                className={`w-8 h-[2px] transition-all duration-300 ${
                  completed ? 'bg-accent-bright/60' : 'bg-white/[0.08]'
                }`}
              />
            )}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-600 transition-all duration-300 ${
                  completed
                    ? 'bg-accent-bright/20 text-accent-bright border border-accent-bright/40'
                    : active
                      ? 'bg-accent-bright text-white border border-accent-bright shadow-[0_0_12px_rgba(99,102,241,0.4)]'
                      : 'bg-white/[0.04] text-text-3 border border-white/[0.08]'
                }`}
              >
                {completed ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`text-[10px] font-500 transition-colors duration-300 ${
                  active ? 'text-accent-bright' : completed ? 'text-text-2' : 'text-text-3'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
