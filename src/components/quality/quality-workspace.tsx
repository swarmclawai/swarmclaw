'use client'

import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { MainContent } from '@/components/layout/main-content'
import { OperationsPulsePanel } from '@/components/operations/operations-pulse-panel'
import { RunList } from '@/components/runs/run-list'
import { PageLoader } from '@/components/ui/page-loader'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/app/api-client'
import {
  buildQualityOverviewSummary,
  groupApprovalsByCategory,
  summarizeEvalRuns,
  summarizeRunHealth,
} from '@/lib/quality/quality-summary'
import type { ArchitectureHealthReport, ArchitectureHealthStatus } from '@/lib/quality/architecture-health'
import type { ReleaseReadinessReport, ReleaseReadinessStatus } from '@/lib/quality/release-readiness'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import type { EvalEnvironmentPlan, EvalGateResult, EvalRun, EvalSuiteResult } from '@/lib/server/eval/types'
import type { Agent, ApprovalRequest, SessionRunRecord } from '@/types'

type QualityTab = 'overview' | 'evals' | 'approvals' | 'runs'

interface EvalSuiteSummary {
  name: string
  count: number
  maxScore: number
  categories: string[]
}

interface EvalScenarioSummary {
  id: string
  name: string
  category: string
  suite: string
  description: string
  tools: string[]
  timeoutMs: number
  criteriaCount: number
  maxScore: number
}

function formatPercent(value: number | null): string {
  return value == null ? 'n/a' : `${value}%`
}

function scorePercent(score: number, maxScore: number): number | null {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return null
  return Math.round((score / maxScore) * 100)
}

function formatTimestamp(at: number | null | undefined): string {
  if (!at) return 'not recorded'
  return new Date(at).toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.round((min / 60) * 10) / 10}h`
}

function agentLabel(agent: Agent | undefined, id: string): string {
  return agent ? `${agent.name} (${agent.model || agent.provider})` : id
}

function StatTile({ label, value, hint, tone = 'default' }: {
  label: string
  value: string
  hint: string
  tone?: 'default' | 'good' | 'warn' | 'danger'
}) {
  const toneClass = {
    default: 'text-text',
    good: 'text-emerald-300',
    warn: 'text-amber-300',
    danger: 'text-rose-300',
  }[tone]
  return (
    <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.03] px-4 py-3">
      <div className="text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/55">{label}</div>
      <div className={cn('mt-2 font-display text-[26px] font-700 tracking-[-0.03em]', toneClass)}>{value}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-text-3/68">{hint}</div>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[14px] border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-6">
      <div className="text-[13px] font-700 text-text">{title}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-text-3/65">{description}</p>
    </div>
  )
}

function environmentStatusClass(status: EvalEnvironmentPlan['status']): string {
  if (status === 'ready') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  if (status === 'warning') return 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  return 'border-rose-500/25 bg-rose-500/10 text-rose-200'
}

function checkClass(level: 'info' | 'warn' | 'error'): string {
  if (level === 'error') return 'border-rose-500/20 bg-rose-500/[0.05] text-rose-200'
  if (level === 'warn') return 'border-amber-500/20 bg-amber-500/[0.05] text-amber-200'
  return 'border-white/[0.06] bg-white/[0.025] text-text-3'
}

function gateStatusClass(status: EvalGateResult['status']): string {
  if (status === 'pass') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  if (status === 'warn') return 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  return 'border-rose-500/25 bg-rose-500/10 text-rose-200'
}

function gateCheckClass(status: EvalGateResult['status']): string {
  if (status === 'fail') return 'border-rose-500/20 bg-rose-500/[0.05] text-rose-200'
  if (status === 'warn') return 'border-amber-500/20 bg-amber-500/[0.05] text-amber-200'
  return 'border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-200'
}

function readinessStatusClass(status: ReleaseReadinessStatus): string {
  if (status === 'ready') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  if (status === 'warning') return 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  return 'border-rose-500/25 bg-rose-500/10 text-rose-200'
}

function readinessScoreTone(status: ReleaseReadinessStatus): string {
  if (status === 'ready') return 'text-emerald-300'
  if (status === 'warning') return 'text-amber-300'
  return 'text-rose-300'
}

function architectureStatusClass(status: ArchitectureHealthStatus): string {
  if (status === 'healthy') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  if (status === 'watch') return 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  return 'border-rose-500/25 bg-rose-500/10 text-rose-200'
}

function architectureScoreTone(status: ArchitectureHealthStatus): string {
  if (status === 'healthy') return 'text-emerald-300'
  if (status === 'watch') return 'text-amber-300'
  return 'text-rose-300'
}

function ReleaseReadinessPanel({
  report,
  loading,
  onRefresh,
  onOpenHref,
}: {
  report: ReleaseReadinessReport | null
  loading: boolean
  onRefresh: () => void
  onOpenHref: (href: string) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-accent-bright/70">{t('releaseReadiness')}</div>
          <h2 className="mt-1 font-display text-[17px] font-700 text-text">{t('shipGateReport')}</h2>
          <p className="mt-1 max-w-[680px] text-[12px] leading-relaxed text-text-3/65">
            {t('releaseReadinessDesc')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-800 text-text-2 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
        >
          {loading ? t('checking') : t('refreshGate')}
        </button>
      </div>

      {!report ? (
        <div className="mt-4 rounded-[12px] border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-5 text-[12px] text-text-3/65">
          {loading ? t('buildingReleaseReport') : t('noReleaseReport')}
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[260px_1fr]">
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.025] p-4">
            <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[10px] font-800 uppercase tracking-[0.1em]', readinessStatusClass(report.status))}>
              {report.status}
            </span>
            <div className={cn('mt-4 font-display text-[42px] font-700 tracking-[-0.04em]', readinessScoreTone(report.status))}>{report.score}</div>
            <div className="mt-1 text-[12px] text-text-3/65">{t('readinessScore')}</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-[10px] bg-white/[0.035] px-3 py-2">
                <div className="text-[10px] font-700 uppercase tracking-[0.1em] text-text-3/50">{t('blockers')}</div>
                <div className="mt-1 text-[18px] font-800 text-text">{report.blockerCount}</div>
              </div>
              <div className="rounded-[10px] bg-white/[0.035] px-3 py-2">
                <div className="text-[10px] font-700 uppercase tracking-[0.1em] text-text-3/50">{t('warnings')}</div>
                <div className="mt-1 text-[18px] font-800 text-text">{report.warningCount}</div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="text-[12px] font-800 text-text">{t('checks')}</div>
              <div className="mt-3 flex flex-col gap-2">
                {report.checks.slice(0, 6).map((check) => (
                  <button
                    key={check.code}
                    type="button"
                    onClick={() => check.href && onOpenHref(check.href)}
                    className={cn(
                      'rounded-[10px] border px-3 py-2 text-left transition-colors',
                      readinessStatusClass(check.status),
                      check.href ? 'hover:bg-white/[0.08]' : '',
                    )}
                  >
                    <div className="text-[11px] font-800 uppercase tracking-[0.08em]">{check.status}</div>
                    <div className="mt-1 text-[12px] font-700 text-text">{check.title}</div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-text-3/70">{check.summary}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="text-[12px] font-800 text-text">{t('nextActions')}</div>
              <div className="mt-3 flex flex-col gap-2">
                {report.nextActions.length === 0 ? (
                  <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.025] px-3 py-4 text-[12px] text-text-3/65">
                    {t('noTriageActions')}
                  </div>
                ) : (
                  report.nextActions.slice(0, 5).map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => onOpenHref(action.href)}
                      className="rounded-[10px] border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[12px] font-800 text-text">{action.title}</div>
                        <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-800 uppercase tracking-[0.08em]', action.severity === 'high' ? 'border-rose-500/25 text-rose-200' : action.severity === 'medium' ? 'border-amber-500/25 text-amber-200' : 'border-emerald-500/25 text-emerald-200')}>
                          {action.severity}
                        </span>
                      </div>
                      <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-3/65">{action.summary}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function ArchitectureHealthPanel({
  report,
  loading,
  onRefresh,
  onOpenHref,
}: {
  report: ArchitectureHealthReport | null
  loading: boolean
  onRefresh: () => void
  onOpenHref: (href: string) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-700 uppercase tracking-[0.12em] text-accent-bright/70">{t('architectureHealth')}</div>
          <h2 className="mt-1 font-display text-[17px] font-700 text-text">{t('runtimeOwnershipMap')}</h2>
          <p className="mt-1 max-w-[680px] text-[12px] leading-relaxed text-text-3/65">
            {t('architectureHealthDesc')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-800 text-text-2 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
        >
          {loading ? t('checking') : t('refreshMap')}
        </button>
      </div>

      {!report ? (
        <div className="mt-4 rounded-[12px] border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-5 text-[12px] text-text-3/65">
          {loading ? t('buildingArchReport') : t('noArchReport')}
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[260px_1fr]">
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.025] p-4">
            <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[10px] font-800 uppercase tracking-[0.1em]', architectureStatusClass(report.status))}>
              {report.status}
            </span>
            <div className={cn('mt-4 font-display text-[42px] font-700 tracking-[-0.04em]', architectureScoreTone(report.status))}>{report.score}</div>
            <div className="mt-1 text-[12px] text-text-3/65">{t('healthScore')}</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-[10px] bg-white/[0.035] px-3 py-2">
                <div className="text-[10px] font-700 uppercase tracking-[0.1em] text-text-3/50">{t('surfaces')}</div>
                <div className="mt-1 text-[18px] font-800 text-text">{report.surfaceCount}</div>
              </div>
              <div className="rounded-[10px] bg-white/[0.035] px-3 py-2">
                <div className="text-[10px] font-700 uppercase tracking-[0.1em] text-text-3/50">{t('guardrails')}</div>
                <div className="mt-1 text-[18px] font-800 text-text">{report.guardrailCount}</div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="text-[12px] font-800 text-text">{t('domains')}</div>
              <div className="mt-3 grid gap-2">
                {report.domains.map((domain) => (
                  <div key={domain.id} className="rounded-[10px] border border-white/[0.06] bg-white/[0.025] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[12px] font-800 text-text">{domain.title}</div>
                      <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-800 uppercase tracking-[0.08em]', architectureStatusClass(domain.status))}>
                        {domain.status}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] leading-relaxed text-text-3/65">{domain.surfaces.length} {t('surfaces')}, {domain.testPaths.length} {t('evidencePaths')}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="text-[12px] font-800 text-text">{t('checks')}</div>
              <div className="mt-3 flex flex-col gap-2">
                {report.nextActions.length === 0 ? (
                  report.checks.filter((check) => check.status === 'healthy').slice(0, 4).map((check) => (
                    <button
                      key={check.code}
                      type="button"
                      onClick={() => check.href && onOpenHref(check.href)}
                      className="rounded-[10px] border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2 text-left text-emerald-200 transition-colors hover:bg-emerald-500/[0.08]"
                    >
                      <div className="text-[11px] font-800 uppercase tracking-[0.08em]">{check.status}</div>
                      <div className="mt-1 text-[12px] font-700 text-text">{check.title}</div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-text-3/70">{check.summary}</div>
                    </button>
                  ))
                ) : (
                  report.nextActions.slice(0, 5).map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => onOpenHref(action.href)}
                      className={cn('rounded-[10px] border px-3 py-2 text-left transition-colors hover:bg-white/[0.08]', architectureStatusClass(action.severity))}
                    >
                      <div className="text-[11px] font-800 uppercase tracking-[0.08em]">{action.severity}</div>
                      <div className="mt-1 text-[12px] font-700 text-text">{action.title}</div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-text-3/70">{action.summary}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function EvalEnvironmentPanel({ plan, loading, onRefresh }: {
  plan: EvalEnvironmentPlan | null
  loading: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.025] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-800 text-text">{t('validationEnvironment')}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-3/65">
            {t('validationEnvironmentDesc')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 rounded-[8px] border border-white/[0.08] px-2 py-1 text-[10px] font-800 text-text-2 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
        >
          {loading ? t('checking') : t('refresh')}
        </button>
      </div>
      {!plan ? (
        <div className="mt-3 text-[11px] text-text-3/60">{loading ? t('checkingReadiness') : t('chooseAgentScenario')}</div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full border px-2 py-1 text-[10px] font-800 uppercase tracking-[0.08em]', environmentStatusClass(plan.status))}>
              {plan.status}
            </span>
            {plan.target && (
              <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">
                {plan.target.kind} - {plan.target.label}
              </span>
            )}
            <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">
              {plan.requiredTools.length} {t('tools')}
            </span>
            <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">
              {plan.generatedFiles.length} {t('files')}
            </span>
          </div>
          {plan.target?.environmentLabel && (
            <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-text-3/70">
              {t('environment')} <span className="font-700 text-text-2">{plan.target.environmentLabel}</span>
              {plan.target.environmentStatus ? ` (${plan.target.environmentStatus})` : ''}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {plan.checks.slice(0, 4).map((check) => (
              <div key={`${check.code}:${check.message}`} className={cn('rounded-[9px] border px-2.5 py-2 text-[11px] leading-relaxed', checkClass(check.level))}>
                <span className="font-800 uppercase tracking-[0.08em]">{check.level}</span>
                <span className="ml-2">{check.message}</span>
              </div>
            ))}
            {plan.checks.length > 4 && (
              <div className="text-[10px] text-text-3/55">{t('moreChecks', { count: plan.checks.length - 4 })}</div>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {plan.generatedFiles.slice(0, 5).map((file) => (
              <span key={`${file.kind}:${file.path}`} className="rounded-full bg-white/[0.04] px-2 py-1 text-[10px] font-700 text-text-3">
                {file.path}
              </span>
            ))}
            {plan.generatedFiles.length > 5 && (
              <span className="rounded-full bg-white/[0.04] px-2 py-1 text-[10px] font-700 text-text-3">
                +{plan.generatedFiles.length - 5}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EvalGatePanel({
  gate,
  loading,
  busy,
  scope,
  onScopeChange,
  onRefresh,
  onSetBaseline,
}: {
  gate: EvalGateResult | null
  loading: boolean
  busy: boolean
  scope: 'scenario' | 'suite'
  onScopeChange: (scope: 'scenario' | 'suite') => void
  onRefresh: () => void
  onSetBaseline: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.025] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-800 text-text">{t('regressionGate')}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-3/65">
            {t('regressionGateDesc')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 rounded-[8px] border border-white/[0.08] px-2 py-1 text-[10px] font-800 text-text-2 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
        >
          {loading ? t('checking') : t('refresh')}
        </button>
      </div>

      <div className="mt-3 flex rounded-[10px] border border-white/[0.06] bg-white/[0.025] p-1">
        {(['scenario', 'suite'] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onScopeChange(item)}
            className={cn(
              'flex-1 rounded-[8px] px-2 py-1.5 text-[10px] font-800 uppercase tracking-[0.08em] transition-colors',
              scope === item ? 'bg-white/[0.1] text-text' : 'text-text-3 hover:bg-white/[0.05]',
            )}
          >
            {item}
          </button>
        ))}
      </div>

      {!gate ? (
        <div className="mt-3 text-[11px] text-text-3/60">{loading ? t('checkingReadiness') : t('runEvalsForGate')}</div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full border px-2 py-1 text-[10px] font-800 uppercase tracking-[0.08em]', gateStatusClass(gate.status))}>
              {gate.status}
            </span>
            <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">
              {gate.scope.label}
            </span>
            <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">
              {gate.latestRuns.length}/{gate.scope.scenarioIds.length} {t('latestRuns')}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-2 py-2">
              <div className="text-[9px] font-800 uppercase tracking-[0.08em] text-text-3/50">{t('current')}</div>
              <div className="mt-1 text-[14px] font-800 text-text">{formatPercent(gate.currentPercent)}</div>
            </div>
            <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-2 py-2">
              <div className="text-[9px] font-800 uppercase tracking-[0.08em] text-text-3/50">{t('baseline')}</div>
              <div className="mt-1 text-[14px] font-800 text-text">{gate.baseline ? `${gate.baseline.baselinePercent}%` : t('none')}</div>
            </div>
            <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-2 py-2">
              <div className="text-[9px] font-800 uppercase tracking-[0.08em] text-text-3/50">{t('regression')}</div>
              <div className="mt-1 text-[14px] font-800 text-text">{gate.regressionPoints == null ? t('n/a') : `${gate.regressionPoints}pt`}</div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            {gate.checks.slice(0, 4).map((check) => (
              <div key={`${check.code}:${check.message}`} className={cn('rounded-[9px] border px-2.5 py-2 text-[11px] leading-relaxed', gateCheckClass(check.status))}>
                <span className="font-800 uppercase tracking-[0.08em]">{check.status}</span>
                <span className="ml-2">{check.message}</span>
              </div>
            ))}
            {gate.checks.length > 4 && (
              <div className="text-[10px] text-text-3/55">{t('moreChecks', { count: gate.checks.length - 4 })}</div>
            )}
          </div>

          <button
            type="button"
            onClick={onSetBaseline}
            disabled={busy || gate.latestRuns.length === 0 || gate.checks.some((check) => check.code === 'missing_scope_runs')}
            className="rounded-[9px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[11px] font-800 text-text-2 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? t('savingBaseline') : gate.baseline ? t('updateBaseline') : t('setBaseline')}
          </button>
        </div>
      )}
    </div>
  )
}

export function QualityWorkspace() {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const agents = useAppStore((s) => s.agents)
  const agentOptions = useMemo(
    () => Object.values(agents).filter((agent) => !agent.trashedAt),
    [agents],
  )

  const TABS: Array<{ id: QualityTab; label: string }> = [
    { id: 'overview', label: t('overview') },
    { id: 'evals', label: t('evalLab') },
    { id: 'approvals', label: t('approvalDesk') },
    { id: 'runs', label: t('runReview') },
  ]

  const [activeTab, setActiveTab] = useState<QualityTab>('overview')
  const [runs, setRuns] = useState<SessionRunRecord[]>([])
  const [evalRuns, setEvalRuns] = useState<EvalRun[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [suites, setSuites] = useState<EvalSuiteSummary[]>([])
  const [scenarios, setScenarios] = useState<EvalScenarioSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedSuite, setSelectedSuite] = useState('core')
  const [selectedScenarioId, setSelectedScenarioId] = useState('')
  const [evalBusy, setEvalBusy] = useState<string | null>(null)
  const [evalEnvironmentPlan, setEvalEnvironmentPlan] = useState<EvalEnvironmentPlan | null>(null)
  const [evalEnvironmentLoading, setEvalEnvironmentLoading] = useState(false)
  const [evalGate, setEvalGate] = useState<EvalGateResult | null>(null)
  const [evalGateScope, setEvalGateScope] = useState<'scenario' | 'suite'>('scenario')
  const [evalGateLoading, setEvalGateLoading] = useState(false)
  const [evalBaselineBusy, setEvalBaselineBusy] = useState(false)
  const [releaseReadiness, setReleaseReadiness] = useState<ReleaseReadinessReport | null>(null)
  const [releaseReadinessLoading, setReleaseReadinessLoading] = useState(false)
  const [architectureHealth, setArchitectureHealth] = useState<ArchitectureHealthReport | null>(null)
  const [architectureHealthLoading, setArchitectureHealthLoading] = useState(false)
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null)

  useEffect(() => {
    const tab = searchParams.get('tab') as QualityTab | null
    if (tab && TABS.some((item) => item.id === tab)) setActiveTab(tab)
  }, [searchParams, TABS])

  const selectTab = useCallback((tab: QualityTab) => {
    setActiveTab(tab)
    router.replace(`/quality?tab=${tab}`, { scroll: false })
  }, [router])

  const openMissionTemplate = useCallback((templateId: string) => {
    router.push(`/missions?template=${encodeURIComponent(templateId)}`)
  }, [router])

  const loadQualityData = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (opts.silent) setRefreshing(true)
    else setLoading(true)
    setLoadError(null)
    try {
      const [nextRuns, nextEvalRuns, nextApprovals, nextSuites, nextScenarios] = await Promise.all([
        api<SessionRunRecord[]>('GET', '/runs?limit=200'),
        api<EvalRun[]>('GET', '/eval/run?limit=100'),
        api<ApprovalRequest[]>('GET', '/approvals'),
        api<EvalSuiteSummary[]>('GET', '/eval/suites'),
        api<EvalScenarioSummary[]>('GET', '/eval/scenarios'),
      ])
      setRuns(Array.isArray(nextRuns) ? nextRuns : [])
      setEvalRuns(Array.isArray(nextEvalRuns) ? nextEvalRuns : [])
      setApprovals(Array.isArray(nextApprovals) ? nextApprovals : [])
      setSuites(Array.isArray(nextSuites) ? nextSuites : [])
      setScenarios(Array.isArray(nextScenarios) ? nextScenarios : [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load quality data'
      setLoadError(message)
      if (!opts.silent) toast.error(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  const loadEvalEnvironmentPlan = useCallback(async (opts: { refreshGateway?: boolean } = {}) => {
    if (!selectedAgentId) {
      setEvalEnvironmentPlan(null)
      return
    }
    const params = new URLSearchParams({ agentId: selectedAgentId })
    if (selectedScenarioId) params.set('scenarioId', selectedScenarioId)
    else if (selectedSuite) params.set('suite', selectedSuite)
    if (opts.refreshGateway) params.set('refreshGateway', 'true')
    setEvalEnvironmentLoading(true)
    try {
      const plan = await api<EvalEnvironmentPlan>('GET', `/eval/environments?${params.toString()}`, undefined, { timeoutMs: opts.refreshGateway ? 20_000 : 8_000 })
      setEvalEnvironmentPlan(plan)
    } catch (err) {
      setEvalEnvironmentPlan(null)
      toast.error(err instanceof Error ? err.message : 'Unable to validate eval environment')
    } finally {
      setEvalEnvironmentLoading(false)
    }
  }, [selectedAgentId, selectedScenarioId, selectedSuite])

  const loadEvalGate = useCallback(async () => {
    if (!selectedAgentId) {
      setEvalGate(null)
      return
    }
    if (evalGateScope === 'scenario' && !selectedScenarioId) {
      setEvalGate(null)
      return
    }
    const params = new URLSearchParams({ agentId: selectedAgentId })
    if (evalGateScope === 'scenario') params.set('scenarioId', selectedScenarioId)
    else params.set('suite', selectedSuite)
    setEvalGateLoading(true)
    try {
      const gate = await api<EvalGateResult>('GET', `/eval/gate?${params.toString()}`)
      setEvalGate(gate)
    } catch (err) {
      setEvalGate(null)
      toast.error(err instanceof Error ? err.message : 'Unable to check eval gate')
    } finally {
      setEvalGateLoading(false)
    }
  }, [evalGateScope, selectedAgentId, selectedScenarioId, selectedSuite])

  const loadReleaseReadiness = useCallback(async () => {
    const params = new URLSearchParams({ range: '7d' })
    if (selectedAgentId) {
      params.set('agentId', selectedAgentId)
      if (evalGateScope === 'scenario' && selectedScenarioId) params.set('scenarioId', selectedScenarioId)
      if (evalGateScope === 'suite') params.set('suite', selectedSuite)
    }
    setReleaseReadinessLoading(true)
    try {
      const report = await api<ReleaseReadinessReport>('GET', `/quality/release-readiness?${params.toString()}`)
      setReleaseReadiness(report)
    } catch (err) {
      setReleaseReadiness(null)
      toast.error(err instanceof Error ? err.message : 'Unable to check release readiness')
    } finally {
      setReleaseReadinessLoading(false)
    }
  }, [evalGateScope, selectedAgentId, selectedScenarioId, selectedSuite])

  const loadArchitectureHealth = useCallback(async () => {
    setArchitectureHealthLoading(true)
    try {
      const report = await api<ArchitectureHealthReport>('GET', '/quality/architecture-health')
      setArchitectureHealth(report)
    } catch (err) {
      setArchitectureHealth(null)
      toast.error(err instanceof Error ? err.message : 'Unable to check architecture health')
    } finally {
      setArchitectureHealthLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadQualityData()
  }, [loadQualityData])

  useEffect(() => {
    void loadArchitectureHealth()
  }, [loadArchitectureHealth])

  useWs('runs', () => { void loadQualityData({ silent: true }) }, 5000)

  useEffect(() => {
    if (!selectedAgentId && agentOptions[0]) setSelectedAgentId(agentOptions[0].id)
  }, [agentOptions, selectedAgentId])

  useEffect(() => {
    if (!selectedScenarioId && scenarios[0]) setSelectedScenarioId(scenarios[0].id)
  }, [scenarios, selectedScenarioId])

  useEffect(() => {
    void loadEvalEnvironmentPlan()
  }, [loadEvalEnvironmentPlan])

  useEffect(() => {
    void loadEvalGate()
  }, [loadEvalGate])

  useEffect(() => {
    void loadReleaseReadiness()
  }, [loadReleaseReadiness])

  useEffect(() => {
    if (!suites.some((suite) => suite.name === selectedSuite) && suites[0]) {
      setSelectedSuite(suites[0].name)
    }
  }, [selectedSuite, suites])

  const scenarioById = useMemo(() => {
    return new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  }, [scenarios])

  const runHealth = useMemo(() => summarizeRunHealth(runs), [runs])
  const evalSummary = useMemo(() => summarizeEvalRuns(evalRuns), [evalRuns])
  const approvalGroups = useMemo(() => groupApprovalsByCategory(approvals), [approvals])
  const overview = useMemo(() => buildQualityOverviewSummary({ runs, evalRuns, approvals }), [approvals, evalRuns, runs])
  const selectedSuiteScenarios = useMemo(
    () => scenarios.filter((scenario) => scenario.suite === selectedSuite),
    [scenarios, selectedSuite],
  )

  const runScenario = useCallback(async () => {
    if (!selectedAgentId || !selectedScenarioId) {
      toast.error(t('chooseAgentScenarioFirst'))
      return
    }
    if (evalEnvironmentPlan?.status === 'blocked') {
      toast.error(t('fixValidationEnv'))
      return
    }
    setEvalBusy(`scenario:${selectedScenarioId}`)
    try {
      await api<EvalRun>('POST', '/eval/run', {
        agentId: selectedAgentId,
        scenarioId: selectedScenarioId,
        gatewayProfileId: evalEnvironmentPlan?.target?.gatewayProfileId || null,
        environmentId: evalEnvironmentPlan?.target?.environmentId || null,
        refreshGateway: evalEnvironmentPlan?.target?.kind === 'gateway',
      }, { timeoutMs: 180_000 })
      toast.success(t('evalScenarioCompleted'))
      await loadQualityData({ silent: true })
      await loadEvalEnvironmentPlan()
      await loadEvalGate()
      await loadReleaseReadiness()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('evalScenarioFailed'))
    } finally {
      setEvalBusy(null)
    }
  }, [evalEnvironmentPlan, loadEvalEnvironmentPlan, loadEvalGate, loadQualityData, loadReleaseReadiness, selectedAgentId, selectedScenarioId, t])

  const runSuite = useCallback(async (suiteName: string) => {
    if (!selectedAgentId) {
      toast.error(t('chooseAgentFirst'))
      return
    }
    if (evalEnvironmentPlan?.status === 'blocked') {
      toast.error(t('fixValidationEnvSuite'))
      return
    }
    setEvalBusy(`suite:${suiteName}`)
    try {
      const result = await api<EvalSuiteResult>('POST', '/eval/suite', {
        agentId: selectedAgentId,
        suite: suiteName,
        gatewayProfileId: evalEnvironmentPlan?.target?.gatewayProfileId || null,
        environmentId: evalEnvironmentPlan?.target?.environmentId || null,
        refreshGateway: evalEnvironmentPlan?.target?.kind === 'gateway',
      }, { timeoutMs: 300_000 })
      toast.success(`${t('suiteCompletedAt')} ${Math.round(result.percentage)}%`)
      await loadQualityData({ silent: true })
      await loadEvalEnvironmentPlan()
      await loadEvalGate()
      await loadReleaseReadiness()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('evalSuiteFailed'))
    } finally {
      setEvalBusy(null)
    }
  }, [evalEnvironmentPlan, loadEvalEnvironmentPlan, loadEvalGate, loadQualityData, loadReleaseReadiness, selectedAgentId, t])

  const setEvalBaseline = useCallback(async () => {
    if (!selectedAgentId) {
      toast.error(t('chooseAgentFirst'))
      return
    }
    if (evalGateScope === 'scenario' && !selectedScenarioId) {
      toast.error(t('chooseScenarioFirst'))
      return
    }
    setEvalBaselineBusy(true)
    try {
      const body = evalGateScope === 'scenario'
        ? { agentId: selectedAgentId, scenarioId: selectedScenarioId, minPercent: evalGate?.minPercent ?? 80, maxRegressionPoints: evalGate?.maxRegressionPoints ?? 5 }
        : { agentId: selectedAgentId, suite: selectedSuite, minPercent: evalGate?.minPercent ?? 80, maxRegressionPoints: evalGate?.maxRegressionPoints ?? 5 }
      const result = await api<{ gate: EvalGateResult }>('POST', '/eval/baselines', body)
      setEvalGate(result.gate)
      await loadReleaseReadiness()
      toast.success(t('evalBaselineSaved'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('evalBaselineSaveFailed'))
    } finally {
      setEvalBaselineBusy(false)
    }
  }, [evalGate, evalGateScope, loadReleaseReadiness, selectedAgentId, selectedScenarioId, selectedSuite, t])

  const actOnApproval = useCallback(async (approval: ApprovalRequest, approved: boolean) => {
    setApprovalBusy(approval.id)
    try {
      await api('POST', '/approvals', { id: approval.id, approved })
      toast.success(approved ? t('approvalGranted') : t('approvalDenied'))
      await loadQualityData({ silent: true })
      await loadReleaseReadiness()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('approvalUpdateFailed'))
    } finally {
      setApprovalBusy(null)
    }
  }, [loadQualityData, loadReleaseReadiness, t])

  if (loading) {
    return (
      <MainContent>
        <PageLoader label={t('loadingQuality')} />
      </MainContent>
    )
  }

  return (
    <MainContent>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-[10px] font-700 uppercase tracking-[0.16em] text-accent-bright/75">{t('operatorQualityCenter')}</div>
              <h1 className="mt-2 font-display text-[28px] font-700 tracking-[-0.03em] text-text">{t('quality')}</h1>
              <p className="mt-2 max-w-[720px] text-[13px] leading-relaxed text-text-3/70">
                {t('qualityDesc')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {refreshing && <span className="text-[11px] text-text-3/60">{t('refreshing')}</span>}
              <button
                type="button"
                onClick={() => {
                  void loadQualityData({ silent: true })
                  void loadArchitectureHealth()
                  void loadReleaseReadiness()
                }}
                className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-700 text-text-2 transition-colors hover:bg-white/[0.08]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 12a9 9 0 0 1-15.5 6.2" /><path d="M3 12A9 9 0 0 1 18.5 5.8" /><path d="M3 19v-5h5" /><path d="M21 5v5h-5" />
                </svg>
                {t('refresh')}
              </button>
            </div>
          </div>

          {loadError && (
            <div className="rounded-[12px] border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-[12px] text-rose-200">
              {loadError}
            </div>
          )}

          <div className="flex gap-1 overflow-x-auto rounded-[12px] border border-white/[0.06] bg-white/[0.025] p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectTab(tab.id)}
                className={cn(
                  'min-w-fit rounded-[9px] px-3 py-2 text-[12px] font-700 transition-colors',
                  activeTab === tab.id
                    ? 'bg-white/[0.1] text-text'
                    : 'text-text-3 hover:bg-white/[0.05] hover:text-text-2',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div className="flex flex-col gap-6">
              <OperationsPulsePanel defaultRange="7d" compact />
              <ReleaseReadinessPanel
                report={releaseReadiness}
                loading={releaseReadinessLoading}
                onRefresh={() => void loadReleaseReadiness()}
                onOpenHref={(href) => router.push(href)}
              />
              <ArchitectureHealthPanel
                report={architectureHealth}
                loading={architectureHealthLoading}
                onRefresh={() => void loadArchitectureHealth()}
                onOpenHref={(href) => router.push(href)}
              />

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <StatTile
                  label={t('needsAttention')}
                  value={String(overview.needsAttention)}
                  hint={t('needsAttentionHint')}
                  tone={overview.needsAttention > 0 ? 'danger' : 'good'}
                />
                <StatTile
                  label={t('activeRuns')}
                  value={String(overview.activeRuns)}
                  hint={t('runStatusHint', { running: runHealth.byStatus.running, queued: runHealth.byStatus.queued })}
                  tone={overview.activeRuns > 0 ? 'warn' : 'default'}
                />
                <StatTile
                  label={t('pendingApprovals')}
                  value={String(overview.pendingApprovals)}
                  hint={t('approvalGroups', { count: approvalGroups.categories.length })}
                  tone={overview.pendingApprovals > 0 ? 'warn' : 'good'}
                />
                <StatTile
                  label={t('evalAverage')}
                  value={formatPercent(overview.evalAveragePercent)}
                  hint={t('evalRunsCompleted', { count: evalSummary.completedRuns })}
                  tone={overview.evalAveragePercent == null || overview.evalAveragePercent >= 80 ? 'good' : 'warn'}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-display text-[15px] font-700 text-text">{t('needsAttention')}</h2>
                      <p className="mt-1 text-[12px] text-text-3/65">{t('needsAttentionDesc')}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => openMissionTemplate('release-candidate-qa')} className="rounded-[9px] border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-700 text-emerald-200 hover:bg-emerald-500/15">{t('startQaMission')}</button>
                      <button onClick={() => selectTab('evals')} className="rounded-[9px] border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-700 text-text-2 hover:bg-white/[0.05]">{t('evalLab')}</button>
                      <button onClick={() => selectTab('approvals')} className="rounded-[9px] border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-700 text-text-2 hover:bg-white/[0.05]">{t('approvals')}</button>
                      <button onClick={() => selectTab('runs')} className="rounded-[9px] border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-700 text-text-2 hover:bg-white/[0.05]">{t('runs')}</button>
                    </div>
                  </div>
                  {runHealth.recentFailures.length === 0 && approvalGroups.totalPending === 0 && evalSummary.failedRuns === 0 ? (
                    <EmptyState title={t('noQualityBlockers')} description={t('noQualityBlockersDesc')} />
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {runHealth.recentFailures.slice(0, 4).map((run) => (
                        <button
                          key={run.id}
                          onClick={() => selectTab('runs')}
                          className="rounded-[12px] border border-rose-500/20 bg-rose-500/[0.04] px-3 py-3 text-left transition-colors hover:bg-rose-500/[0.07]"
                        >
                          <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-rose-300">{t('failedRun')}</div>
                          <div className="mt-1 truncate text-[13px] font-600 text-text">{run.messagePreview || run.id}</div>
                          <div className="mt-1 text-[11px] text-text-3/60">{run.source} - {formatTimestamp(run.endedAt ?? run.queuedAt)}</div>
                        </button>
                      ))}
                      {approvalGroups.categories.slice(0, 4).map((group) => (
                        <button
                          key={group.category}
                          onClick={() => selectTab('approvals')}
                          className="rounded-[12px] border border-amber-500/20 bg-amber-500/[0.04] px-3 py-3 text-left transition-colors hover:bg-amber-500/[0.07]"
                        >
                          <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-amber-300">{t('approval')}</div>
                          <div className="mt-1 text-[13px] font-600 text-text">{group.count} {t('pending')} {group.category.replaceAll('_', ' ')}</div>
                          <div className="mt-1 text-[11px] text-text-3/60">{group.approvals[0]?.title || t('reviewRequest')}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
                  <h2 className="font-display text-[15px] font-700 text-text">{t('latestEvalScores')}</h2>
                  <p className="mt-1 text-[12px] text-text-3/65">{t('latestEvalScoresDesc')}</p>
                  <div className="mt-4 flex flex-col gap-2">
                    {evalRuns.slice(0, 5).length === 0 ? (
                      <EmptyState title={t('noEvalHistory')} description={t('noEvalHistoryDesc')} />
                    ) : (
                      evalRuns.slice(0, 5).map((run) => {
                        const percent = scorePercent(run.score, run.maxScore)
                        return (
                          <div key={run.id} className="rounded-[12px] border border-white/[0.06] bg-white/[0.025] px-3 py-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-700 text-text">{scenarioById.get(run.scenarioId)?.name || run.scenarioId}</div>
                                <div className="mt-1 text-[11px] text-text-3/60">{agentLabel(agents[run.agentId], run.agentId)}</div>
                              </div>
                              <div className={cn('shrink-0 text-[16px] font-display font-700', percent == null || percent >= 80 ? 'text-emerald-300' : 'text-amber-300')}>
                                {formatPercent(percent)}
                              </div>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}

          {activeTab === 'evals' && (
            <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
              <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
                <h2 className="font-display text-[15px] font-700 text-text">{t('evalLab')}</h2>
                <p className="mt-1 text-[12px] leading-relaxed text-text-3/65">{t('evalLabDesc')}</p>
                <div className="mt-4 flex flex-col gap-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('agent')}</span>
                    <select
                      value={selectedAgentId}
                      onChange={(event) => setSelectedAgentId(event.target.value)}
                      className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-text outline-none"
                    >
                      {agentOptions.length === 0 && <option value="">{t('noAgentsAvailable')}</option>}
                      {agentOptions.map((agent) => (
                        <option key={agent.id} value={agent.id}>{agent.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/55">{t('scenario')}</span>
                    <select
                      value={selectedScenarioId}
                      onChange={(event) => setSelectedScenarioId(event.target.value)}
                      className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-text outline-none"
                    >
                      {scenarios.map((scenario) => (
                        <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
                      ))}
                    </select>
                  </label>
                  {selectedScenarioId && scenarioById.get(selectedScenarioId) && (
                    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.025] px-3 py-3">
                      <div className="text-[13px] font-700 text-text">{scenarioById.get(selectedScenarioId)!.name}</div>
                      <p className="mt-1 text-[12px] leading-relaxed text-text-3/65">{scenarioById.get(selectedScenarioId)!.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">{scenarioById.get(selectedScenarioId)!.category}</span>
                        <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">{scenarioById.get(selectedScenarioId)!.criteriaCount} {t('criteria')}</span>
                        <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">{formatDuration(scenarioById.get(selectedScenarioId)!.timeoutMs)}</span>
                      </div>
                    </div>
                  )}
                  <EvalEnvironmentPanel
                    plan={evalEnvironmentPlan}
                    loading={evalEnvironmentLoading}
                    onRefresh={() => void loadEvalEnvironmentPlan({ refreshGateway: true })}
                  />
                  <EvalGatePanel
                    gate={evalGate}
                    loading={evalGateLoading}
                    busy={evalBaselineBusy}
                    scope={evalGateScope}
                    onScopeChange={setEvalGateScope}
                    onRefresh={() => void loadEvalGate()}
                    onSetBaseline={() => void setEvalBaseline()}
                  />
                  <button
                    type="button"
                    onClick={() => openMissionTemplate('release-candidate-qa')}
                    className="mt-3 w-full rounded-[10px] border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12px] font-800 text-emerald-200 transition-colors hover:bg-emerald-500/15"
                  >
                    {t('startReleaseQa')}
                  </button>
                  <button
                    type="button"
                    disabled={!selectedAgentId || !selectedScenarioId || !!evalBusy}
                    onClick={() => void runScenario()}
                    className="inline-flex items-center justify-center gap-2 rounded-[10px] bg-accent-bright px-3 py-2.5 text-[12px] font-800 text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    {evalBusy?.startsWith('scenario:') ? t('runningScenario') : t('runScenario')}
                  </button>
                </div>
              </section>

              <div className="flex flex-col gap-5">
                <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-[15px] font-700 text-text">{t('suites')}</h2>
                      <p className="mt-1 text-[12px] text-text-3/65">{t('suitesDesc')}</p>
                    </div>
                    <select
                      value={selectedSuite}
                      onChange={(event) => setSelectedSuite(event.target.value)}
                      className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] text-text outline-none"
                    >
                      {suites.map((suite) => (
                        <option key={suite.name} value={suite.name}>{suite.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {suites.map((suite) => (
                      <div key={suite.name} className="rounded-[14px] border border-white/[0.06] bg-white/[0.025] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[13px] font-800 text-text">{suite.name}</div>
                            <div className="mt-1 text-[11px] text-text-3/65">{t('scenariosCount', { count: suite.count, maxScore: suite.maxScore })}</div>
                          </div>
                          <button
                            type="button"
                            disabled={!selectedAgentId || !!evalBusy}
                            onClick={() => void runSuite(suite.name)}
                            className="rounded-[8px] border border-white/[0.08] px-2 py-1 text-[11px] font-700 text-text-2 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {evalBusy === `suite:${suite.name}` ? t('running') : t('run')}
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {suite.categories.map((category) => (
                            <span key={category} className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-700 text-text-3">{category}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 text-[11px] text-text-3/60">
                    {t('scenariosSelected', { count: selectedSuiteScenarios.length, suite: selectedSuite })}
                  </div>
                </section>

                <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
                  <h2 className="font-display text-[15px] font-700 text-text">{t('scoreHistory')}</h2>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {evalRuns.length === 0 ? (
                      <EmptyState title={t('noEvalResults')} description={t('noEvalResultsDesc')} />
                    ) : (
                      evalRuns.slice(0, 12).map((run) => {
                        const percent = scorePercent(run.score, run.maxScore)
                        const scenario = scenarioById.get(run.scenarioId)
                        return (
                          <div key={run.id} className="rounded-[14px] border border-white/[0.06] bg-white/[0.025] p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-800 text-text">{scenario?.name || run.scenarioId}</div>
                                <div className="mt-1 text-[11px] text-text-3/60">{agentLabel(agents[run.agentId], run.agentId)}</div>
                                <div className="mt-1 text-[10px] text-text-3/50">{formatTimestamp(run.endedAt ?? run.startedAt)}</div>
                              </div>
                              <div className={cn('rounded-[8px] px-2 py-1 text-[13px] font-800', percent == null || percent >= 80 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300')}>
                                {formatPercent(percent)}
                              </div>
                            </div>
                            <div className="mt-3 flex flex-col gap-2">
                              {run.details.slice(0, 3).map((detail) => (
                                <div key={detail.criterion} className="rounded-[10px] bg-white/[0.025] px-3 py-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="text-[11px] font-700 text-text-2">{detail.criterion}</div>
                                    <div className="text-[10px] text-text-3/70">{detail.score}/{detail.maxScore}</div>
                                  </div>
                                  {detail.evidence && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-3/65">{detail.evidence}</p>}
                                </div>
                              ))}
                              {run.details.length > 3 && (
                                <div className="text-[10px] text-text-3/50">{t('moreCriteria', { count: run.details.length - 3 })}</div>
                              )}
                              {run.error && <div className="rounded-[10px] bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-200">{run.error}</div>}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}

          {activeTab === 'approvals' && (
            <section className="rounded-[16px] border border-white/[0.06] bg-white/[0.025] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-[15px] font-700 text-text">{t('approvalDesk')}</h2>
                  <p className="mt-1 text-[12px] text-text-3/65">{t('approvalDeskDesc')}</p>
                </div>
                <div className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[11px] font-700 text-text-3">
                  {approvalGroups.totalPending} {t('pending')}
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-4">
                {approvalGroups.totalPending === 0 ? (
                  <EmptyState title={t('noPendingApprovals')} description={t('approvalQueueClear')} />
                ) : (
                  approvalGroups.categories.map((group) => (
                    <div key={group.category} className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-[12px] font-800 uppercase tracking-[0.1em] text-text-2">{group.category.replaceAll('_', ' ')}</div>
                        <div className="text-[11px] font-700 text-text-3/65">{t('requests', { count: group.count })}</div>
                      </div>
                      <div className="grid gap-2 lg:grid-cols-2">
                        {group.approvals.map((approval) => (
                          <div key={approval.id} className="rounded-[12px] border border-white/[0.06] bg-surface px-3 py-3">
                            <div className="text-[13px] font-800 text-text">{approval.title}</div>
                            {approval.description && <p className="mt-1 text-[12px] leading-relaxed text-text-3/65">{approval.description}</p>}
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-3/55">
                              <span>{formatTimestamp(approval.createdAt)}</span>
                              {approval.agentId && <span>agent {agents[approval.agentId]?.name || approval.agentId}</span>}
                              {approval.sessionId && <span>session {approval.sessionId.slice(0, 8)}</span>}
                            </div>
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                disabled={approvalBusy === approval.id}
                                onClick={() => void actOnApproval(approval, true)}
                                className="inline-flex items-center gap-1.5 rounded-[9px] bg-emerald-400 px-3 py-1.5 text-[11px] font-800 text-black transition-opacity hover:opacity-90 disabled:opacity-40"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                  <path d="M20 6L9 17l-5-5" />
                                </svg>
                                {t('approve')}
                              </button>
                              <button
                                type="button"
                                disabled={approvalBusy === approval.id}
                                onClick={() => void actOnApproval(approval, false)}
                                className="inline-flex items-center gap-1.5 rounded-[9px] border border-rose-400/25 bg-rose-500/[0.06] px-3 py-1.5 text-[11px] font-800 text-rose-200 transition-colors hover:bg-rose-500/[0.1] disabled:opacity-40"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                  <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                                </svg>
                                {t('deny')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {activeTab === 'runs' && (
            <div className="flex min-h-[680px] flex-col rounded-[16px] border border-white/[0.06] bg-white/[0.025]">
              <div className="border-b border-white/[0.06] px-5 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="font-display text-[15px] font-700 text-text">{t('runReview')}</h2>
                    <p className="mt-1 text-[12px] text-text-3/65">{t('runReviewDesc')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-rose-500/[0.08] px-2.5 py-1 text-[11px] font-700 text-rose-300">{runHealth.byStatus.failed} {t('failed')}</span>
                    <span className="rounded-full bg-blue-500/[0.08] px-2.5 py-1 text-[11px] font-700 text-blue-300">{runHealth.byStatus.running} {t('running')}</span>
                    <span className="rounded-full bg-emerald-500/[0.08] px-2.5 py-1 text-[11px] font-700 text-emerald-300">{runHealth.byStatus.completed} {t('completed')}</span>
                  </div>
                </div>
              </div>
              <RunList />
            </div>
          )}
        </div>
      </div>
    </MainContent>
  )
}
