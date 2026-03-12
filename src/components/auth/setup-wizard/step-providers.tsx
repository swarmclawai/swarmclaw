'use client'

import { useState } from 'react'
import { api } from '@/lib/app/api-client'
import { errorMessage } from '@/lib/shared-utils'
import { SETUP_PROVIDERS } from '@/lib/setup-defaults'
import type { StepProvidersProps, SetupDoctorResponse } from './types'
import { StepShell, SkipLink, ConfiguredProviderChips } from './shared'

export function StepProviders({
  configuredProviders,
  configuredProviderIds,
  error,
  canContinue,
  onSelectProvider,
  onRemoveProvider,
  onContinue,
  onSkip,
}: StepProvidersProps) {
  const [doctorState, setDoctorState] = useState<'idle' | 'checking' | 'done' | 'error'>('idle')
  const [doctorError, setDoctorError] = useState('')
  const [doctorReport, setDoctorReport] = useState<SetupDoctorResponse | null>(null)

  const runSetupDoctor = async () => {
    setDoctorState('checking')
    setDoctorError('')
    try {
      const report = await api<SetupDoctorResponse>('GET', '/setup/doctor')
      setDoctorReport(report)
      setDoctorState('done')
    } catch (err: unknown) {
      setDoctorState('error')
      setDoctorReport(null)
      setDoctorError(errorMessage(err))
    }
  }

  return (
    <StepShell>
      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
        Connect a Provider
      </h1>
      <p className="text-[15px] text-text-2 mb-2">
        Pick a provider to get started. You can add more later.
      </p>
      <p className="text-[13px] text-text-3 mb-8">
        Each provider you connect can be used across any agents you create.
      </p>

      <ConfiguredProviderChips providers={configuredProviders} onRemove={onRemoveProvider} />

      <div className="flex flex-col gap-3 max-h-[42vh] overflow-y-auto pr-1">
        {SETUP_PROVIDERS.map((candidate) => {
          const isConfigured = configuredProviderIds.has(candidate.id)
          return (
            <button
              key={candidate.id}
              onClick={() => onSelectProvider(candidate.id)}
              className={`w-full px-5 py-4 rounded-[14px] border bg-surface text-left
                transition-all duration-200 flex items-start gap-4 cursor-pointer
                ${isConfigured
                  ? 'border-emerald-500/25 hover:border-emerald-500/40 hover:bg-surface-hover'
                  : 'border-white/[0.08] hover:border-accent-bright/30 hover:bg-surface-hover'
                }`}
            >
              <div className={`w-10 h-10 rounded-[10px] border flex items-center justify-center shrink-0 mt-0.5 ${
                isConfigured ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/[0.04] border-white/[0.06]'
              }`}>
                <span className={`text-[16px] font-display font-700 ${isConfigured ? 'text-emerald-400' : 'text-accent-bright'}`}>
                  {candidate.icon}
                </span>
              </div>
              <div className="flex-1">
                <div className="text-[15px] font-display font-600 text-text mb-1">
                  {candidate.name}
                  {isConfigured ? (
                    <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 text-[10px] uppercase tracking-[0.08em] font-600">
                      Connected · Edit
                    </span>
                  ) : candidate.badge ? (
                    <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-bright/15 text-accent-bright text-[10px] uppercase tracking-[0.08em] font-600">
                      {candidate.badge}
                    </span>
                  ) : null}
                </div>
                <div className="text-[13px] text-text-3 leading-relaxed">{candidate.description}</div>
                {!candidate.requiresKey && !isConfigured && (
                  <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-[11px] font-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    No API key required
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      <div className="mt-4 text-left">
        <button
          onClick={runSetupDoctor}
          disabled={doctorState === 'checking'}
          className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-white/[0.02] text-[13px] text-text-2
            cursor-pointer hover:bg-white/[0.05] transition-all duration-200 disabled:opacity-40"
        >
          {doctorState === 'checking' ? 'Running System Check...' : 'Run System Check'}
        </button>

        {doctorState === 'error' && doctorError && (
          <p className="mt-2 text-[12px] text-red-300">{doctorError}</p>
        )}

        {doctorReport && doctorState === 'done' && (
          <div className="mt-3 p-3 rounded-[12px] border border-white/[0.08] bg-surface">
            <div className={`text-[12px] font-600 ${doctorReport.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
              {doctorReport.summary}
            </div>
            {doctorReport.checks.filter((check) => check.status !== 'pass').slice(0, 3).map((check) => (
              <div key={check.id} className="mt-1 text-[11px] text-text-3">
                - {check.label}: {check.detail}
              </div>
            ))}
            {!!doctorReport.actions?.length && (
              <div className="mt-2 text-[11px] text-text-3/80">
                Next: {doctorReport.actions.slice(0, 2).join(' ')}
              </div>
            )}
          </div>
        )}
      </div>

      {error && <p className="mt-4 text-[13px] text-red-400">{error}</p>}

      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          onClick={onSkip}
          className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
            font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
        >
          Skip for now
        </button>
        <button
          onClick={onContinue}
          disabled={!canContinue}
          className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
            cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
            shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
        >
          {configuredProviders.length > 0 ? 'Set Up Agents' : 'Continue'}
        </button>
      </div>
    </StepShell>
  )
}
