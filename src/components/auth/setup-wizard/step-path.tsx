'use client'

import { ONBOARDING_PATHS } from '@/lib/setup-defaults'
import type { StepPathProps } from './types'
import { StepShell, SkipLink } from './shared'
import { formatAgentCount, getStarterKitsForPath } from './utils'

export function StepPath({
  onboardingPath,
  starterKitId,
  intentText,
  onPathChange,
  onStarterKitChange,
  onIntentTextChange,
  onContinue,
  onBack,
  onSkip,
}: StepPathProps) {
  const visibleStarterKits = getStarterKitsForPath(onboardingPath)

  return (
    <StepShell wide>
      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
        Choose Your Start
      </h1>
      <p className="text-[15px] text-text-2 mb-2">
        Pick the setup path that matches how much guidance you want.
      </p>
      <p className="text-[13px] text-text-3 mb-7">
        You can still edit providers, prompts, tools, and agent details before finishing setup.
      </p>

      <div className="grid gap-3 md:grid-cols-3 text-left mb-6">
        {ONBOARDING_PATHS.map((path) => {
          const active = path.id === onboardingPath
          return (
            <button
              key={path.id}
              type="button"
              onClick={() => onPathChange(path.id)}
              className={`rounded-[18px] border px-5 py-4 text-left transition-all duration-200 cursor-pointer ${
                active
                  ? 'border-accent-bright/35 bg-accent-soft shadow-[0_0_24px_rgba(99,102,241,0.12)]'
                  : 'border-white/[0.08] bg-surface hover:border-accent-bright/20 hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="text-[15px] font-display font-700 text-text">{path.title}</div>
                {path.badge ? (
                  <span className={`rounded-full px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] ${
                    active ? 'bg-accent-bright text-black' : 'bg-white/[0.05] text-text-3/80'
                  }`}>
                    {path.badge}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-text-2">{path.description}</p>
              <p className="mt-3 text-[12px] leading-relaxed text-text-3/72">{path.detail}</p>
            </button>
          )
        })}
      </div>

      {onboardingPath === 'intent' && (
        <div className="mb-6 rounded-[18px] border border-white/[0.08] bg-surface px-5 py-4 text-left">
          <label className="block text-[12px] font-700 uppercase tracking-[0.12em] text-text-3/60 mb-2">
            What Are You Setting Up SwarmClaw To Do?
          </label>
          <textarea
            value={intentText}
            onChange={(event) => onIntentTextChange(event.target.value)}
            rows={3}
            placeholder="e.g. Help me run product research every week, summarize findings, and turn them into follow-up tasks."
            className="w-full rounded-[14px] border border-white/[0.08] bg-bg px-4 py-3 text-[14px] text-text outline-none transition-all duration-200 resize-none placeholder:text-text-3/45 focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
          />
          <p className="mt-2 text-[12px] leading-relaxed text-text-3/72">
            This is used only to seed the starter prompts. It does not auto-classify your workflow.
          </p>
        </div>
      )}

      <div className="rounded-[20px] border border-white/[0.08] bg-surface p-5 text-left">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/55">Starting Shape</div>
            <div className="mt-1 text-[13px] text-text-3/72">
              Start from a broad team shape instead of a niche preset. You can still edit every agent before setup finishes.
            </div>
          </div>
          <div className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/70">
            {visibleStarterKits.length} options
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleStarterKits.map((kit) => {
            const active = starterKitId === kit.id
            return (
              <button
                key={kit.id}
                type="button"
                onClick={() => onStarterKitChange(kit.id)}
                className={`rounded-[18px] border px-4 py-4 text-left transition-all duration-200 cursor-pointer ${
                  active
                    ? 'border-accent-bright/35 bg-accent-soft shadow-[0_0_24px_rgba(99,102,241,0.12)]'
                    : 'border-white/[0.08] bg-white/[0.02] hover:border-accent-bright/20 hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[15px] font-display font-700 text-text">{kit.name}</div>
                  <span className={`rounded-full px-2 py-1 text-[10px] font-700 uppercase tracking-[0.12em] ${
                    active ? 'bg-accent-bright text-black' : 'bg-white/[0.05] text-text-3/80'
                  }`}>
                    {kit.badge || formatAgentCount(kit.agents.length)}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-text-2">{kit.description}</p>
                <p className="mt-3 text-[12px] leading-relaxed text-text-3/72">{kit.detail}</p>
                {kit.agents.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {kit.agents.map((agent) => (
                      <span
                        key={agent.id}
                        className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text-2"
                      >
                        {agent.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 rounded-[12px] border border-dashed border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-text-3/70">
                    Finish setup without starter agents.
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          onClick={onBack}
          className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
        >
          Back
        </button>
        <button
          onClick={onContinue}
          className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600 cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200 shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
        >
          Continue to Providers
        </button>
      </div>

      <SkipLink onClick={onSkip} />
    </StepShell>
  )
}
