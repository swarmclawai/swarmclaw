import crypto from 'crypto'
import type { Mission, MissionBudget, MissionReportSchedule, MissionStatus } from '@/types'
import { DEFAULT_MISSION_WARN_FRACTIONS } from '@/types'
import { hmrSingleton } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'
import {
  appendMissionEvent,
  appendMissionMilestone,
  getMission,
  listMissions,
  patchMission,
  upsertMission,
} from './mission-repository'

const TAG = 'mission-service'

interface MissionRuntimeCache {
  sessionToMission: Map<string, string>
  hydratedAt: number
}

const runtime = hmrSingleton<MissionRuntimeCache>('mission_runtime_state', () => ({
  sessionToMission: new Map(),
  hydratedAt: 0,
}))

function hydrateSessionMap(force = false): void {
  const now = Date.now()
  if (!force && now - runtime.hydratedAt < 30_000) return
  const missions = listMissions()
  const next = new Map<string, string>()
  for (const m of missions) {
    if (m.status === 'running' || m.status === 'paused') {
      if (m.rootSessionId) next.set(m.rootSessionId, m.id)
    }
  }
  runtime.sessionToMission = next
  runtime.hydratedAt = now
}

export function getMissionIdForSession(sessionId: string): string | null {
  if (!sessionId) return null
  hydrateSessionMap(false)
  return runtime.sessionToMission.get(sessionId) ?? null
}

export function trackSessionMissionMapping(sessionId: string, missionId: string | null): void {
  if (!sessionId) return
  if (missionId) runtime.sessionToMission.set(sessionId, missionId)
  else runtime.sessionToMission.delete(sessionId)
}

export interface CreateMissionInput {
  title: string
  goal: string
  successCriteria?: string[]
  rootSessionId: string
  agentIds?: string[]
  budget?: Partial<MissionBudget>
  reportSchedule?: MissionReportSchedule | null
  reportConnectorIds?: string[]
}

function newMissionId(): string {
  return `mi_${crypto.randomBytes(8).toString('hex')}`
}

function sanitizeBudget(input: Partial<MissionBudget> = {}): MissionBudget {
  const pick = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const warn = Array.isArray(input.warnAtFractions) && input.warnAtFractions.length
    ? input.warnAtFractions.filter((f) => typeof f === 'number' && f > 0 && f < 1)
    : DEFAULT_MISSION_WARN_FRACTIONS
  return {
    maxUsd: pick(input.maxUsd),
    maxTokens: pick(input.maxTokens),
    maxToolCalls: pick(input.maxToolCalls),
    maxWallclockSec: pick(input.maxWallclockSec),
    maxTurns: pick(input.maxTurns),
    warnAtFractions: warn.length ? warn : DEFAULT_MISSION_WARN_FRACTIONS,
  }
}

export function createMission(input: CreateMissionInput): Mission {
  const now = Date.now()
  const mission: Mission = {
    id: newMissionId(),
    title: input.title.trim(),
    goal: input.goal.trim(),
    successCriteria: (input.successCriteria ?? []).map((s) => s.trim()).filter(Boolean),
    rootSessionId: input.rootSessionId,
    agentIds: input.agentIds ?? [],
    status: 'draft',
    budget: sanitizeBudget(input.budget),
    usage: {
      usdSpent: 0,
      tokensUsed: 0,
      toolCallsUsed: 0,
      turnsRun: 0,
      wallclockMsElapsed: 0,
      startedAt: null,
      lastUpdatedAt: now,
      warnFractionsHit: [],
    },
    milestones: [],
    reportSchedule: input.reportSchedule ?? null,
    reportConnectorIds: input.reportConnectorIds ?? [],
    createdAt: now,
    updatedAt: now,
  }
  upsertMission(mission)
  log.info(TAG, `Created mission ${mission.id} (goal: ${mission.goal.slice(0, 80)})`)
  return mission
}

function applyStatusTransition(
  id: string,
  next: MissionStatus,
  opts: { reason?: string; milestoneSummary?: string; endReason?: string } = {},
): Mission | null {
  const updated = patchMission(id, (current) => {
    if (!current) return null
    const patch: Mission = { ...current, status: next }
    if (next === 'running' && !current.usage.startedAt) {
      patch.usage = { ...current.usage, startedAt: Date.now(), lastUpdatedAt: Date.now() }
      patch.startedAt = patch.startedAt ?? Date.now()
    }
    if (next === 'completed' || next === 'failed' || next === 'cancelled' || next === 'budget_exhausted') {
      patch.endedAt = Date.now()
      patch.endReason = opts.endReason ?? opts.reason ?? null
    }
    return patch
  })
  if (!updated) return null
  if (opts.milestoneSummary) {
    appendMissionMilestone(id, {
      kind: mapStatusToMilestoneKind(next),
      summary: opts.milestoneSummary,
    })
  }
  trackSessionMissionMapping(
    updated.rootSessionId,
    next === 'running' || next === 'paused' ? id : null,
  )
  return getMission(id)
}

function mapStatusToMilestoneKind(
  status: MissionStatus,
): 'started' | 'paused' | 'resumed' | 'completed' | 'failed' | 'cancelled' | 'budget_hit' {
  switch (status) {
    case 'running': return 'started'
    case 'paused': return 'paused'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'budget_exhausted': return 'budget_hit'
    default: return 'started'
  }
}

export function startMission(id: string): Mission | null {
  const current = getMission(id)
  if (!current) return null
  if (current.status === 'running') return current
  const next = current.status === 'paused' ? 'running' : 'running'
  const summary = current.status === 'paused' ? 'Mission resumed' : 'Mission started'
  const updated = applyStatusTransition(id, next, { milestoneSummary: summary })
  if (updated && current.status === 'paused') {
    appendMissionMilestone(id, { kind: 'resumed', summary: 'Mission resumed' })
  }
  return updated
}

export function pauseMission(id: string, reason?: string): Mission | null {
  const current = getMission(id)
  if (!current || current.status !== 'running') return current
  return applyStatusTransition(id, 'paused', {
    reason,
    milestoneSummary: reason ?? 'Mission paused',
  })
}

export function cancelMission(id: string, reason?: string): Mission | null {
  const current = getMission(id)
  if (!current) return null
  if (current.status === 'completed' || current.status === 'cancelled') return current
  return applyStatusTransition(id, 'cancelled', {
    endReason: reason,
    milestoneSummary: reason ?? 'Mission cancelled',
  })
}

export function completeMission(id: string, summary?: string): Mission | null {
  const current = getMission(id)
  if (!current) return null
  if (current.status === 'completed') return current
  return applyStatusTransition(id, 'completed', {
    endReason: summary,
    milestoneSummary: summary ?? 'Mission complete',
  })
}

export function failMission(id: string, reason: string): Mission | null {
  const current = getMission(id)
  if (!current) return null
  if (current.status === 'failed') return current
  return applyStatusTransition(id, 'failed', {
    endReason: reason,
    milestoneSummary: reason,
  })
}

export function markBudgetExhausted(id: string, reason: string): Mission | null {
  const current = getMission(id)
  if (!current) return null
  if (current.status === 'budget_exhausted' || current.status === 'completed') return current
  appendMissionEvent(id, 'budget_exhausted', { reason })
  return applyStatusTransition(id, 'budget_exhausted', {
    endReason: reason,
    milestoneSummary: reason,
  })
}

export interface BudgetVerdict {
  allow: boolean
  reason?: string
  hitCap?: 'usd' | 'tokens' | 'toolCalls' | 'wallclock' | 'turns'
  warningFraction?: number
}

export function evaluateMissionBudget(mission: Mission, at: number = Date.now()): BudgetVerdict {
  const { budget, usage } = mission
  if (budget.maxUsd != null && usage.usdSpent >= budget.maxUsd) {
    return { allow: false, hitCap: 'usd', reason: `USD budget exhausted (${usage.usdSpent.toFixed(4)} >= ${budget.maxUsd})` }
  }
  if (budget.maxTokens != null && usage.tokensUsed >= budget.maxTokens) {
    return { allow: false, hitCap: 'tokens', reason: `Token budget exhausted (${usage.tokensUsed} >= ${budget.maxTokens})` }
  }
  if (budget.maxToolCalls != null && usage.toolCallsUsed >= budget.maxToolCalls) {
    return { allow: false, hitCap: 'toolCalls', reason: `Tool-call budget exhausted (${usage.toolCallsUsed} >= ${budget.maxToolCalls})` }
  }
  if (budget.maxTurns != null && usage.turnsRun >= budget.maxTurns) {
    return { allow: false, hitCap: 'turns', reason: `Max turns reached (${usage.turnsRun} >= ${budget.maxTurns})` }
  }
  if (budget.maxWallclockSec != null && usage.startedAt != null) {
    const elapsedSec = (at - usage.startedAt) / 1000
    if (elapsedSec >= budget.maxWallclockSec) {
      return { allow: false, hitCap: 'wallclock', reason: `Wallclock budget exhausted (${Math.round(elapsedSec)}s >= ${budget.maxWallclockSec}s)` }
    }
  }
  // Warn thresholds, highest unfired fraction first
  const unfired = (budget.warnAtFractions ?? [])
    .filter((f) => !usage.warnFractionsHit.includes(f))
    .sort((a, b) => b - a)
  for (const fraction of unfired) {
    const tripped = (
      (budget.maxUsd != null && usage.usdSpent >= budget.maxUsd * fraction)
      || (budget.maxTokens != null && usage.tokensUsed >= budget.maxTokens * fraction)
      || (budget.maxTurns != null && usage.turnsRun >= budget.maxTurns * fraction)
      || (
        budget.maxWallclockSec != null && usage.startedAt != null
        && (at - usage.startedAt) / 1000 >= budget.maxWallclockSec * fraction
      )
    )
    if (tripped) return { allow: true, warningFraction: fraction }
  }
  return { allow: true }
}

export function recordTurnUsage(
  missionId: string,
  delta: { usdDelta?: number; tokensDelta?: number; toolCallsDelta?: number; turnsDelta?: number },
): Mission | null {
  let firedWarn: number | null = null
  const result = patchMission(missionId, (current) => {
    if (!current) return null
    const now = Date.now()
    const nextUsage = { ...current.usage }
    if (typeof delta.usdDelta === 'number' && Number.isFinite(delta.usdDelta)) nextUsage.usdSpent += delta.usdDelta
    if (typeof delta.tokensDelta === 'number' && Number.isFinite(delta.tokensDelta)) nextUsage.tokensUsed += delta.tokensDelta
    if (typeof delta.toolCallsDelta === 'number' && Number.isFinite(delta.toolCallsDelta)) nextUsage.toolCallsUsed += delta.toolCallsDelta
    if (typeof delta.turnsDelta === 'number' && Number.isFinite(delta.turnsDelta)) nextUsage.turnsRun += delta.turnsDelta
    if (nextUsage.startedAt) nextUsage.wallclockMsElapsed = now - nextUsage.startedAt
    nextUsage.lastUpdatedAt = now
    const verdict = evaluateMissionBudget({ ...current, usage: nextUsage }, now)
    if (verdict.warningFraction != null) {
      firedWarn = verdict.warningFraction
      nextUsage.warnFractionsHit = [...nextUsage.warnFractionsHit, verdict.warningFraction]
    }
    return { ...current, usage: nextUsage }
  })
  if (result && firedWarn != null) {
    appendMissionMilestone(missionId, {
      kind: 'budget_warn',
      summary: `Budget ${Math.round(firedWarn * 100)}% reached`,
    })
  }
  return result
}
