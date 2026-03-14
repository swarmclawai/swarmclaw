'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { FilterPill } from '@/components/ui/filter-pill'
import { StatCard } from '@/components/ui/stat-card'
import { timeAgo } from '@/lib/time-format'
import type { ApprovalRequest, EstopState, SupervisorIncident } from '@/types'

type EstopResponse = EstopState & {
  ok?: boolean
  approval?: ApprovalRequest | null
  resumeRequiresApproval?: boolean
}
type EstopActionResponse = {
  ok?: boolean
  requiresApproval?: boolean
  approval?: ApprovalRequest | null
  state: EstopResponse
}
type IncidentFilter = 'all' | 'high' | 'runtime_failure'
const INCIDENT_DETAILS_PREVIEW_CHARS = 320

function formatTimestamp(value?: number | null): string {
  if (!value) return 'Not recorded'
  return new Date(value).toLocaleString()
}

function formatApprovalStatus(status?: ApprovalRequest['status'] | null): string {
  if (status === 'approved') return 'Approved'
  if (status === 'rejected') return 'Rejected'
  if (status === 'pending') return 'Pending approval'
  return 'No approval requested'
}

function estopTone(level: EstopState['level'] | null | undefined): {
  badge: string
  glow: string
  panel: string
} {
  if (level === 'all') {
    return {
      badge: 'bg-red-500/12 text-red-300 border border-red-500/20',
      glow: 'from-red-500/18 via-red-500/6 to-transparent',
      panel: 'border-red-500/18 bg-red-500/[0.06]',
    }
  }
  if (level === 'autonomy') {
    return {
      badge: 'bg-amber-500/12 text-amber-300 border border-amber-500/20',
      glow: 'from-amber-500/18 via-amber-500/6 to-transparent',
      panel: 'border-amber-500/18 bg-amber-500/[0.06]',
    }
  }
  return {
    badge: 'bg-emerald-500/12 text-emerald-300 border border-emerald-500/20',
    glow: 'from-emerald-500/18 via-sky-500/6 to-transparent',
    panel: 'border-emerald-500/18 bg-emerald-500/[0.05]',
  }
}

function severityTone(severity: SupervisorIncident['severity']): {
  badge: string
  rail: string
} {
  if (severity === 'high') {
    return {
      badge: 'bg-red-500/12 text-red-300 border border-red-500/20',
      rail: 'bg-red-400/80',
    }
  }
  if (severity === 'medium') {
    return {
      badge: 'bg-amber-500/12 text-amber-300 border border-amber-500/20',
      rail: 'bg-amber-400/80',
    }
  }
  return {
    badge: 'bg-sky-500/12 text-sky-300 border border-sky-500/20',
    rail: 'bg-sky-400/80',
  }
}

function looksLikeHtmlIncidentPayload(value?: string | null): boolean {
  if (!value) return false
  const normalized = value.toLowerCase()
  let matches = 0
  for (const marker of ['<!doctype html', '<html', '<head', '<body', '<script', '/_next/static/', '__next_error__']) {
    if (!normalized.includes(marker)) continue
    matches += 1
    if (matches >= 2) return true
  }
  return false
}

function previewIncidentDetails(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (looksLikeHtmlIncidentPayload(trimmed)) {
    return 'Stored HTML error payload captured. This usually means the runtime hit a Next.js or server-side exception rather than a normal autonomy note.'
  }
  if (trimmed.length <= INCIDENT_DETAILS_PREVIEW_CHARS) return trimmed
  return `${trimmed.slice(0, INCIDENT_DETAILS_PREVIEW_CHARS - 1).trimEnd()}…`
}

export default function AutonomyPage() {
  const [estop, setEstop] = useState<EstopResponse | null>(null)
  const [incidents, setIncidents] = useState<SupervisorIncident[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<'autonomy' | 'all' | 'resume' | 'refresh' | 'policy' | 'approve' | 'reject' | null>(null)
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>('all')
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'refresh') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    try {
      const [estopState, incidentList] = await Promise.all([
        api<EstopResponse>('GET', '/autonomy/estop'),
        api<SupervisorIncident[]>('GET', '/autonomy/incidents?limit=60'),
      ])
      setEstop(estopState)
      setIncidents(Array.isArray(incidentList) ? incidentList : [])
      setRefreshedAt(Date.now())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load autonomy state.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  async function engage(level: 'autonomy' | 'all') {
    setPendingAction(level)
    try {
      const result = await api<{ state: EstopResponse }>('POST', '/autonomy/estop', {
        action: 'engage',
        level,
        engagedBy: 'ui',
        reason: level === 'all' ? 'Manual full estop' : 'Manual autonomy estop',
      })
      setEstop(result.state)
      setActionMessage(level === 'all' ? 'Full estop engaged.' : 'Autonomy estop engaged.')
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to engage estop.')
    } finally {
      setPendingAction(null)
    }
  }

  async function setResumeApprovalPolicy(enabled: boolean) {
    setPendingAction('policy')
    try {
      await api('PUT', '/settings', {
        autonomyResumeApprovalsEnabled: enabled,
      })
      setActionMessage(
        enabled
          ? 'Resume approvals enabled.'
          : 'Resume approvals disabled. Estops can now be cleared directly.',
      )
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update resume approval policy.')
    } finally {
      setPendingAction(null)
    }
  }

  async function resumeNow(approvalId?: string | null) {
    setPendingAction('resume')
    try {
      const body: Record<string, unknown> = {
        action: 'resume',
        requester: 'ui',
      }
      if (approvalId) body.approvalId = approvalId
      const result = await api<EstopActionResponse>('POST', '/autonomy/estop', body)
      setEstop(result.state)
      if (result.ok) {
        setActionMessage('Autonomy resumed.')
      } else {
        setActionMessage(result?.approval?.id
          ? `Resume approval requested: ${result.approval.id}`
          : 'Resume request submitted.')
      }
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resume autonomy.')
    } finally {
      setPendingAction(null)
    }
  }

  async function approveAndResume() {
    const approvalId = estop?.approval?.id
    if (!approvalId) return
    setPendingAction('approve')
    try {
      await api('POST', '/approvals', { id: approvalId, approved: true })
      const result = await api<EstopActionResponse>('POST', '/autonomy/estop', {
        action: 'resume',
        approvalId,
        requester: 'ui',
      })
      setEstop(result.state)
      setActionMessage('Resume approved and autonomy resumed.')
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to approve and resume autonomy.')
    } finally {
      setPendingAction(null)
    }
  }

  async function rejectResume() {
    const approvalId = estop?.approval?.id
    if (!approvalId) return
    setPendingAction('reject')
    try {
      await api('POST', '/approvals', { id: approvalId, approved: false })
      setActionMessage('Resume request rejected.')
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reject the resume request.')
    } finally {
      setPendingAction(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await load('initial')
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const sortedIncidents = useMemo(
    () => [...incidents].sort((left, right) => right.createdAt - left.createdAt),
    [incidents],
  )

  const filteredIncidents = useMemo(() => {
    if (incidentFilter === 'high') return sortedIncidents.filter((incident) => incident.severity === 'high')
    if (incidentFilter === 'runtime_failure') return sortedIncidents.filter((incident) => incident.kind === 'runtime_failure')
    return sortedIncidents
  }, [incidentFilter, sortedIncidents])

  const latestIncident = sortedIncidents[0] || null
  const highSeverityCount = sortedIncidents.filter((incident) => incident.severity === 'high').length
  const runtimeFailureCount = sortedIncidents.filter((incident) => incident.kind === 'runtime_failure').length
  const tone = estopTone(estop?.level)
  const now = Date.now()
  const approval = estop?.approval || null
  const resumeRequiresApproval = estop?.resumeRequiresApproval === true

  const modeLabel = estop?.level === 'all'
    ? 'Full stop'
    : estop?.level === 'autonomy'
      ? 'Autonomy paused'
      : 'Operational'

  const modeDescription = estop?.level === 'all'
    ? 'All new execution is blocked until a resume approval is granted.'
    : estop?.level === 'autonomy'
      ? 'Background loops are paused, but direct operator work can still continue.'
      : 'Autonomy, direct chats, and daemon-managed execution are available.'

  const resumeState = estop?.level === 'none'
    ? 'Not needed'
    : !resumeRequiresApproval
      ? 'Direct resume enabled'
      : approval?.id
        ? `${formatApprovalStatus(approval.status)} ${approval.id}`
        : 'No approval requested'
  const recoveryTitle = !resumeRequiresApproval
    ? 'Resume directly'
    : approval?.status === 'pending'
      ? 'Approve and resume'
      : approval?.status === 'approved'
        ? 'Resume from approved request'
        : approval?.status === 'rejected'
          ? 'Request a new approval'
          : 'Request resume approval'

  const recoveryDescription = !resumeRequiresApproval
    ? 'Resume approvals are currently disabled, so operators can clear estops directly while this feature is still being tested.'
    : approval?.status === 'pending'
      ? 'A human-loop approval is waiting. Resolve it here, then the estop will clear immediately.'
      : approval?.status === 'approved'
        ? 'The current resume request is already approved. Clear the estop to restore autonomy.'
        : approval?.status === 'rejected'
          ? 'The last resume request was rejected. Create a new one when you are ready to continue.'
          : 'Create a human-loop approval before clearing the current estop.'

  async function refresh() {
    setPendingAction('refresh')
    try {
      await load()
      setActionMessage('Autonomy state refreshed.')
    } finally {
      setPendingAction(null)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-6xl space-y-5 animate-pulse">
          <div className="h-56 rounded-[24px] border border-white/[0.05] bg-white/[0.03]" />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="h-24 rounded-[16px] border border-white/[0.05] bg-white/[0.03]" />
            <div className="h-24 rounded-[16px] border border-white/[0.05] bg-white/[0.03]" />
            <div className="h-24 rounded-[16px] border border-white/[0.05] bg-white/[0.03]" />
            <div className="h-24 rounded-[16px] border border-white/[0.05] bg-white/[0.03]" />
          </div>
          <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="h-[420px] rounded-[20px] border border-white/[0.05] bg-white/[0.03]" />
            <div className="h-[420px] rounded-[20px] border border-white/[0.05] bg-white/[0.03]" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <section className="relative overflow-hidden rounded-[24px] border border-white/[0.06] bg-surface">
          <div className={`absolute inset-0 bg-gradient-to-br ${tone.glow}`} />
          <div className="absolute right-[-60px] top-[-80px] h-48 w-48 rounded-full bg-white/[0.04] blur-3xl" />
          <div className="relative grid gap-6 p-6 md:p-7 xl:grid-cols-[minmax(0,1.4fr)_320px]">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[10px] font-700 uppercase tracking-[0.14em] text-text-3/70">
                Runtime Safety Desk
                {refreshing && <span className="text-[9px] text-text-3/50">Refreshing</span>}
              </div>
              <div className="space-y-2">
                <h1 className="font-display text-[28px] font-700 tracking-[-0.03em] text-text">Autonomy Control</h1>
                <p className="max-w-2xl text-[14px] leading-[1.7] text-text-3/78">
                  Control emergency stops, see recent runtime failures, and manage the operator handoff when autonomy needs intervention.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-700 uppercase tracking-[0.08em] ${tone.badge}`}>
                  {modeLabel}
                </span>
                <span className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] text-text-3/72">
                  Refreshed {refreshedAt ? timeAgo(refreshedAt, now) : 'recently'}
                </span>
                {latestIncident && (
                  <span className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] text-text-3/72">
                    Latest incident {timeAgo(latestIncident.createdAt, now)}
                  </span>
                )}
              </div>
            </div>

            <div className={`rounded-[20px] border p-5 backdrop-blur-sm ${tone.panel}`}>
              <div className="mb-2 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/65">Current State</div>
              <div className="font-display text-[24px] font-700 tracking-[-0.03em] text-text">{modeLabel}</div>
              <p className="mt-2 text-[13px] leading-[1.7] text-text-3/78">
                {estop?.reason || modeDescription}
              </p>
              <div className="mt-4 space-y-2 text-[12px] text-text-3/72">
                <div className="flex items-center justify-between gap-3">
                  <span>Updated</span>
                  <span className="font-mono text-text-2">{formatTimestamp(estop?.updatedAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Engaged by</span>
                  <span className="text-text-2">{estop?.engagedBy || 'system'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Resume policy</span>
                  <span className="text-right text-text-2">{resumeRequiresApproval ? 'Approval required' : 'Direct resume'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Resume state</span>
                  <span className="text-right text-text-2">{resumeState}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            index={0}
            label="Mode"
            value={modeLabel}
            accent={estop?.level !== 'none'}
            hint="Current estop state for the runtime."
          />
          <StatCard
            index={1}
            label="Incidents"
            value={sortedIncidents.length}
            hint="Recent supervisor incidents recorded by the runtime."
          />
          <StatCard
            index={2}
            label="High Severity"
            value={highSeverityCount}
            hint="Incidents that likely need direct operator attention."
          />
          <StatCard
            index={3}
            label="Runtime Failures"
            value={runtimeFailureCount}
            hint="Failures normalized into transport, auth, connector, and recovery families."
          />
        </div>

        {(error || actionMessage) && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className={`rounded-[16px] border px-4 py-3 text-[12px] ${
              error
                ? 'border-red-500/20 bg-red-500/[0.06] text-red-200'
                : 'border-transparent bg-transparent text-transparent'
            }`}>
              {error || ' '}
            </div>
            <div className={`rounded-[16px] border px-4 py-3 text-[12px] ${
              actionMessage
                ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200'
                : 'border-transparent bg-transparent text-transparent'
            }`}>
              {actionMessage || ' '}
            </div>
          </div>
        )}

        <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className="rounded-[20px] border border-white/[0.06] bg-surface p-5">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex-1">
                <h2 className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">Operator Actions</h2>
                <p className="mt-1 text-[12px] leading-[1.7] text-text-3/72">
                  Use the lightest stop that matches the issue. Resume approvals are disabled by default while the safety desk is still being validated, but you can turn them on here if you want the extra gate.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={pendingAction === 'refresh'}
                className="rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] font-700 uppercase tracking-[0.08em] text-text-2 transition-all hover:bg-white/[0.06] cursor-pointer disabled:cursor-default disabled:opacity-45"
              >
                {pendingAction === 'refresh' ? 'Refreshing' : 'Refresh'}
              </button>
            </div>

            <div className="space-y-3">
              <div className="rounded-[16px] border border-amber-500/16 bg-amber-500/[0.05] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-amber-500/12 px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] text-amber-300">
                    Background only
                  </span>
                </div>
                <h3 className="text-[13px] font-700 text-text">Engage autonomy estop</h3>
                <p className="mt-1 text-[12px] leading-[1.7] text-text-3/72">
                  Pauses scheduler, daemon, connectors, retries, and other autonomous background work while keeping direct operator chats available.
                </p>
                <button
                  type="button"
                  onClick={() => void engage('autonomy')}
                  disabled={pendingAction !== null || estop?.level === 'autonomy'}
                  className="mt-4 w-full rounded-[12px] border-none bg-amber-500/14 px-3 py-2.5 text-[12px] font-700 text-amber-200 transition-all hover:bg-amber-500/20 active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                >
                  {pendingAction === 'autonomy' ? 'Engaging autonomy estop...' : estop?.level === 'autonomy' ? 'Autonomy estop active' : 'Engage autonomy estop'}
                </button>
              </div>

              <div className="rounded-[16px] border border-red-500/16 bg-red-500/[0.05] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-red-500/12 px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] text-red-300">
                    Hard stop
                  </span>
                </div>
                <h3 className="text-[13px] font-700 text-text">Engage full estop</h3>
                <p className="mt-1 text-[12px] leading-[1.7] text-text-3/72">
                  Blocks all new chat, tool, and model execution. Use this when the runtime needs a complete halt before recovery.
                </p>
                <button
                  type="button"
                  onClick={() => void engage('all')}
                  disabled={pendingAction !== null || estop?.level === 'all'}
                  className="mt-4 w-full rounded-[12px] border-none bg-red-500/14 px-3 py-2.5 text-[12px] font-700 text-red-200 transition-all hover:bg-red-500/20 active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                >
                  {pendingAction === 'all' ? 'Engaging full estop...' : estop?.level === 'all' ? 'Full estop active' : 'Engage full estop'}
                </button>
              </div>

              <div className="rounded-[16px] border border-sky-500/14 bg-sky-500/[0.05] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-sky-500/12 px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] text-sky-300">
                    Policy
                  </span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[13px] font-700 text-text">Require approval before resume</h3>
                    <p className="mt-1 text-[12px] leading-[1.7] text-text-3/72">
                      Leave this off to let operators clear estops directly. Turn it on if you want a human-loop approval step before autonomy resumes.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void setResumeApprovalPolicy(!resumeRequiresApproval)}
                    disabled={pendingAction !== null}
                    aria-pressed={resumeRequiresApproval}
                    aria-label={resumeRequiresApproval ? 'Disable resume approval requirement' : 'Enable resume approval requirement'}
                    className={`ml-3 flex h-6 w-11 shrink-0 items-center rounded-full border px-[3px] transition-all duration-200 cursor-pointer ${
                      resumeRequiresApproval
                        ? 'border-accent-bright/35 bg-accent shadow-[0_0_0_1px_rgba(89,153,255,0.12)]'
                        : 'border-white/[0.10] bg-white/[0.08]'
                    } disabled:cursor-default disabled:opacity-45`}
                  >
                    <span className={`h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-200 ${
                      resumeRequiresApproval ? 'translate-x-[20px]' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
                <div className="mt-3 text-[11px] text-text-3/65">
                  {pendingAction === 'policy'
                    ? 'Updating policy...'
                    : resumeRequiresApproval
                      ? 'Approval mode is enabled for future estop resumes.'
                      : 'Direct resume mode is enabled for future estop resumes.'}
                </div>
              </div>

              <div className="rounded-[16px] border border-white/[0.08] bg-white/[0.02] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/70">
                    Recovery
                  </span>
                </div>
                <h3 className="text-[13px] font-700 text-text">{recoveryTitle}</h3>
                <p className="mt-1 text-[12px] leading-[1.7] text-text-3/72">
                  {recoveryDescription}
                </p>
                {approval && (
                  <div className="mt-3 rounded-[12px] border border-white/[0.08] bg-black/10 px-3 py-2.5 text-[11px] text-text-3/70">
                    <div className="flex items-center justify-between gap-3">
                      <span>Approval id</span>
                      <span className="font-mono text-text-2">{approval.id}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <span>Status</span>
                      <span className="text-text-2">{formatApprovalStatus(approval.status)}</span>
                    </div>
                  </div>
                )}
                {!resumeRequiresApproval ? (
                  <button
                    type="button"
                    onClick={() => void resumeNow()}
                    disabled={pendingAction !== null || estop?.level === 'none'}
                    className="mt-4 w-full rounded-[12px] border border-emerald-500/18 bg-emerald-500/12 px-3 py-2.5 text-[12px] font-700 text-emerald-200 transition-all hover:bg-emerald-500/18 active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                  >
                    {pendingAction === 'resume' ? 'Resuming autonomy...' : estop?.level === 'none' ? 'No estop active' : 'Resume now'}
                  </button>
                ) : approval?.status === 'pending' ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void approveAndResume()}
                      disabled={pendingAction !== null || estop?.level === 'none'}
                      className="rounded-[12px] border border-emerald-500/18 bg-emerald-500/12 px-3 py-2.5 text-[12px] font-700 text-emerald-200 transition-all hover:bg-emerald-500/18 active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                    >
                      {pendingAction === 'approve' ? 'Approving and resuming...' : 'Approve and resume'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void rejectResume()}
                      disabled={pendingAction !== null}
                      className="rounded-[12px] border border-white/[0.08] bg-white/[0.05] px-3 py-2.5 text-[12px] font-700 text-text-2 transition-all hover:bg-white/[0.08] active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                    >
                      {pendingAction === 'reject' ? 'Rejecting...' : 'Reject'}
                    </button>
                  </div>
                ) : approval?.status === 'approved' ? (
                  <button
                    type="button"
                    onClick={() => void resumeNow(approval.id)}
                    disabled={pendingAction !== null || estop?.level === 'none'}
                    className="mt-4 w-full rounded-[12px] border border-emerald-500/18 bg-emerald-500/12 px-3 py-2.5 text-[12px] font-700 text-emerald-200 transition-all hover:bg-emerald-500/18 active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                  >
                    {pendingAction === 'resume' ? 'Resuming autonomy...' : estop?.level === 'none' ? 'No estop active' : 'Resume now'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void resumeNow()}
                    disabled={pendingAction !== null || estop?.level === 'none'}
                    className="mt-4 w-full rounded-[12px] border border-white/[0.08] bg-white/[0.05] px-3 py-2.5 text-[12px] font-700 text-text-2 transition-all hover:bg-white/[0.08] active:scale-[0.98] cursor-pointer disabled:cursor-default disabled:opacity-45"
                  >
                    {pendingAction === 'resume'
                      ? 'Requesting resume approval...'
                      : estop?.level === 'none'
                        ? 'No estop active'
                        : approval?.status === 'rejected'
                          ? 'Request a new approval'
                          : 'Request resume approval'}
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-[20px] border border-white/[0.06] bg-surface p-5">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="flex-1">
                <h2 className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">Recent Incidents</h2>
                <p className="mt-1 text-[12px] leading-[1.7] text-text-3/72">
                  Filter the incident feed to focus on the most urgent failures or the normalized runtime-family issues added for autonomy recovery.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <FilterPill
                  label={`All ${sortedIncidents.length}`}
                  active={incidentFilter === 'all'}
                  onClick={() => setIncidentFilter('all')}
                />
                <FilterPill
                  label={`High ${highSeverityCount}`}
                  active={incidentFilter === 'high'}
                  onClick={() => setIncidentFilter('high')}
                />
                <FilterPill
                  label={`Runtime ${runtimeFailureCount}`}
                  active={incidentFilter === 'runtime_failure'}
                  onClick={() => setIncidentFilter('runtime_failure')}
                />
              </div>
            </div>

            {filteredIncidents.length === 0 ? (
              <div className="flex min-h-[280px] items-center justify-center rounded-[18px] border border-dashed border-white/[0.08] bg-white/[0.02] p-8 text-center">
                <div className="max-w-[320px]">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] border border-white/[0.08] bg-white/[0.03] text-text-3/55">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l7 3v6c0 4.4-2.92 8.46-7 9-4.08-.54-7-4.6-7-9V6l7-3z" />
                      <path d="M9.5 12.5l1.7 1.7 3.3-4.2" />
                    </svg>
                  </div>
                  <h3 className="font-display text-[16px] font-700 tracking-[-0.02em] text-text">No incidents in this view</h3>
                  <p className="mt-2 text-[12px] leading-[1.7] text-text-3/70">
                    {incidentFilter === 'all'
                      ? 'The runtime has not recorded any supervisor incidents yet.'
                      : 'Try switching filters to view the broader incident stream.'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredIncidents.map((incident) => {
                  const severity = severityTone(incident.severity)
                  return (
                    <article
                      key={incident.id}
                      className="relative overflow-hidden rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4 transition-all hover:bg-white/[0.03]"
                    >
                      <div className={`absolute inset-y-0 left-0 w-1 ${severity.rail}`} />
                      <div className="pl-2">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${severity.badge}`}>
                            {incident.severity}
                          </span>
                          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/70">
                            {incident.kind.replace(/_/g, ' ')}
                          </span>
                          {incident.failureFamily && (
                            <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] text-text-3/65">
                              {incident.failureFamily}
                            </span>
                          )}
                          <span className="ml-auto text-[11px] text-text-3/55" title={formatTimestamp(incident.createdAt)}>
                            {timeAgo(incident.createdAt, now)}
                          </span>
                        </div>

                        <h3 className="text-[14px] font-700 text-text">{incident.summary}</h3>

                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-3/58">
                          <span>Source {incident.source}</span>
                          {incident.agentId && <span>Agent {incident.agentId}</span>}
                          {incident.runId && <span>Run {incident.runId}</span>}
                          {incident.toolName && <span>Tool {incident.toolName}</span>}
                        </div>

                        {incident.remediation && (
                          <div className="mt-3 rounded-[12px] border border-emerald-500/14 bg-emerald-500/[0.05] px-3 py-2.5">
                            <div className="mb-1 text-[10px] font-700 uppercase tracking-[0.08em] text-emerald-300/85">Remediation</div>
                            <div className="text-[12px] leading-[1.7] text-emerald-100/80 whitespace-pre-wrap">{incident.remediation}</div>
                          </div>
                        )}

                        {incident.details && (
                          (() => {
                            const isHtmlPayload = looksLikeHtmlIncidentPayload(incident.details)
                            const detailsPreview = previewIncidentDetails(incident.details)
                            const needsExpansion = isHtmlPayload || incident.details.length > INCIDENT_DETAILS_PREVIEW_CHARS
                            if (!needsExpansion) {
                              return (
                                <div className="mt-3 text-[12px] leading-[1.7] text-text-3/72 whitespace-pre-wrap break-words">
                                  {incident.details}
                                </div>
                              )
                            }
                            return (
                              <div className={`mt-3 rounded-[12px] border px-3 py-2.5 ${
                                isHtmlPayload
                                  ? 'border-red-500/16 bg-red-500/[0.05]'
                                  : 'border-white/[0.08] bg-white/[0.02]'
                              }`}>
                                <div className="text-[12px] leading-[1.7] text-text-2/82 whitespace-pre-wrap break-words">
                                  {detailsPreview}
                                </div>
                                <details className="mt-2 rounded-[10px] border border-white/[0.06] bg-black/10">
                                  <summary className="cursor-pointer list-none px-3 py-2 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/62 [&::-webkit-details-marker]:hidden">
                                    {isHtmlPayload ? 'Show raw payload' : 'Show full details'}
                                  </summary>
                                  <div className="max-h-64 overflow-auto border-t border-white/[0.06] px-3 py-3 text-[12px] leading-[1.7] text-text-3/72 whitespace-pre-wrap break-all">
                                    {incident.details}
                                  </div>
                                </details>
                              </div>
                            )
                          })()
                        )}

                        {incident.repairPrompt && (
                          <div className="mt-3 rounded-[12px] border border-white/[0.08] bg-black/10 px-3 py-2.5">
                            <div className="mb-1 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/60">Repair Prompt</div>
                            <div className="text-[12px] leading-[1.7] text-text-2/88 whitespace-pre-wrap">{incident.repairPrompt}</div>
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
