import { listPendingApprovals } from '@/lib/server/approvals'
import { getConnectorReadiness } from '@/lib/connectors/connector-readiness'
import { loadConnectors } from '@/lib/server/connectors/connector-repository'
import { listOpenClawGatewayProfiles } from '@/lib/server/gateways/gateway-profile-service'
import { listMissions } from '@/lib/server/missions/mission-repository'
import { listUnifiedRuns } from '@/lib/server/runs/unified-run-queries'
import type {
  ApprovalRequest,
  Connector,
  GatewayProfile,
  Mission,
  OperationPulse,
  OperationPulseAction,
  OperationPulseRange,
  OperationPulseSeverity,
  SessionRunRecord,
} from '@/types'

const RANGE_MS: Record<OperationPulseRange, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
}

const SEVERITY_RANK: Record<OperationPulseSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

const ACTIVE_MISSION_STATUSES = new Set<Mission['status']>(['running', 'paused'])
const GATEWAY_TOPOLOGY_STALE_MS = 30 * 60_000

export function normalizeOperationPulseRange(value: string | null | undefined): OperationPulseRange {
  return value === '7d' ? '7d' : '24h'
}

function isWithinWindow(at: number | null | undefined, windowStart: number): boolean {
  return typeof at === 'number' && Number.isFinite(at) && at >= windowStart
}

function runActivityAt(run: SessionRunRecord): number {
  return run.endedAt || run.startedAt || run.queuedAt || 0
}

function budgetFractions(mission: Mission, now: number): Array<{ label: string; fraction: number }> {
  const usage = mission.usage
  const budget = mission.budget
  const rows: Array<{ label: string; fraction: number }> = []
  if (budget.maxUsd && budget.maxUsd > 0) rows.push({ label: 'USD', fraction: usage.usdSpent / budget.maxUsd })
  if (budget.maxTokens && budget.maxTokens > 0) rows.push({ label: 'tokens', fraction: usage.tokensUsed / budget.maxTokens })
  if (budget.maxToolCalls && budget.maxToolCalls > 0) rows.push({ label: 'tool calls', fraction: usage.toolCallsUsed / budget.maxToolCalls })
  if (budget.maxTurns && budget.maxTurns > 0) rows.push({ label: 'turns', fraction: usage.turnsRun / budget.maxTurns })
  if (budget.maxWallclockSec && budget.maxWallclockSec > 0) {
    const elapsed = usage.startedAt ? Math.max(usage.wallclockMsElapsed, now - usage.startedAt) : usage.wallclockMsElapsed
    rows.push({ label: 'wallclock', fraction: elapsed / (budget.maxWallclockSec * 1000) })
  }
  return rows
}

function budgetPressure(mission: Mission, now: number): { label: string; fraction: number } | null {
  const rows = budgetFractions(mission, now).sort((left, right) => right.fraction - left.fraction)
  const top = rows[0]
  return top && top.fraction >= 0.8 ? top : null
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function addAction(actions: OperationPulseAction[], action: OperationPulseAction): void {
  actions.push(action)
}

function gatewayPendingPairings(gateway: GatewayProfile): number {
  return (gateway.stats?.pendingNodePairings || 0) + (gateway.stats?.pendingDevicePairings || 0)
}

function gatewayAttentionReason(gateway: GatewayProfile, now: number): {
  severity: OperationPulseSeverity
  summary: string
  evidence: string[]
} | null {
  const pendingPairings = gatewayPendingPairings(gateway)
  const errorCount = gateway.stats?.lastTopologyErrorCount || 0
  const checkedAt = gateway.stats?.lastTopologyCheckedAt || gateway.lastCheckedAt || null
  const staleTopology = !checkedAt || now - checkedAt > GATEWAY_TOPOLOGY_STALE_MS
  const evidence = [
    `status:${gateway.status}`,
    `${gateway.stats?.connectedNodeCount || 0}/${gateway.stats?.nodeCount || 0} nodes`,
    `${gateway.stats?.availableEnvironmentCount || 0}/${gateway.stats?.environmentCount || 0} environments`,
  ]

  if (gateway.status === 'offline') {
    return {
      severity: 'high',
      summary: `${gateway.name} is offline${gateway.lastError ? `: ${gateway.lastError}` : '.'}`,
      evidence,
    }
  }

  if (gateway.status === 'degraded') {
    return {
      severity: 'high',
      summary: `${gateway.name} is degraded${gateway.lastError ? `: ${gateway.lastError}` : '.'}`,
      evidence,
    }
  }

  if (errorCount > 0) {
    return {
      severity: 'medium',
      summary: `${gateway.name} topology refresh reported ${errorCount} error${errorCount === 1 ? '' : 's'}.`,
      evidence: [...evidence, gateway.stats?.lastTopologyError || 'topology error'].filter(Boolean),
    }
  }

  if ((gateway.stats?.environmentCount || 0) > 0 && (gateway.stats?.availableEnvironmentCount || 0) === 0) {
    return {
      severity: 'high',
      summary: `${gateway.name} has no available OpenClaw execution environments.`,
      evidence,
    }
  }

  if (pendingPairings > 0) {
    return {
      severity: 'medium',
      summary: `${gateway.name} has ${pendingPairings} pending OpenClaw pairing request${pendingPairings === 1 ? '' : 's'}.`,
      evidence: [...evidence, `${pendingPairings} pending pairings`],
    }
  }

  if (staleTopology) {
    return {
      severity: 'medium',
      summary: `${gateway.name} topology has not been refreshed in the last 30 minutes.`,
      evidence,
    }
  }

  return null
}

function sortActions(actions: OperationPulseAction[]): OperationPulseAction[] {
  return [...actions]
    .sort((left, right) => {
      const severityDelta = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      if (severityDelta !== 0) return severityDelta
      return (right.createdAt || 0) - (left.createdAt || 0)
    })
    .slice(0, 12)
}

export function buildOperationPulse(input: {
  range: OperationPulseRange
  now: number
  missions: Mission[]
  runs: SessionRunRecord[]
  approvals: ApprovalRequest[]
  connectors: Connector[]
  gateways?: GatewayProfile[]
}): OperationPulse {
  const windowStart = input.now - RANGE_MS[input.range]
  const windowRuns = input.runs.filter((run) => run.status === 'running' || run.status === 'queued' || isWithinWindow(runActivityAt(run), windowStart))
  const activeMissions = input.missions.filter((mission) => ACTIVE_MISSION_STATUSES.has(mission.status))
  const runningRuns = windowRuns.filter((run) => run.status === 'running' || run.status === 'queued')
  const failedRuns = windowRuns.filter((run) => run.status === 'failed')
  const pendingApprovals = input.approvals.filter((approval) => approval.status === 'pending')
  const connectorReadiness = input.connectors.map((connector) => ({ connector, readiness: getConnectorReadiness(connector) }))
  const connectorAttention = connectorReadiness.filter((item) => item.readiness.state !== 'healthy')
  const gatewayAttention = (input.gateways || [])
    .map((gateway) => ({ gateway, reason: gatewayAttentionReason(gateway, input.now) }))
    .filter((item): item is { gateway: GatewayProfile; reason: NonNullable<ReturnType<typeof gatewayAttentionReason>> } => Boolean(item.reason))
  const budgetWarnings = input.missions
    .map((mission) => ({ mission, pressure: budgetPressure(mission, input.now) }))
    .filter((item) => item.pressure)

  const actions: OperationPulseAction[] = []

  for (const run of failedRuns.slice(0, 5)) {
    addAction(actions, {
      id: `run:${run.id}`,
      kind: 'run',
      severity: 'high',
      title: 'Review failed run',
      summary: run.error || run.resultPreview || run.messagePreview || run.id,
      href: '/quality?tab=runs',
      evidence: [run.source, run.ownerType && run.ownerId ? `${run.ownerType}:${run.ownerId}` : 'runtime run'].filter(Boolean) as string[],
      createdAt: runActivityAt(run),
    })
  }

  for (const approval of pendingApprovals.slice(0, 5)) {
    addAction(actions, {
      id: `approval:${approval.id}`,
      kind: 'approval',
      severity: approval.category === 'budget_change' ? 'high' : 'medium',
      title: 'Resolve pending approval',
      summary: approval.title || approval.description || approval.category,
      href: '/quality?tab=approvals',
      evidence: [approval.category, approval.agentId ? `agent:${approval.agentId}` : '', approval.taskId ? `task:${approval.taskId}` : ''].filter(Boolean),
      createdAt: approval.createdAt,
    })
  }

  for (const item of connectorAttention.slice(0, 5)) {
    addAction(actions, {
      id: `connector:${item.connector.id}`,
      kind: 'connector',
      severity: item.connector.status === 'error' || item.readiness.recentError ? 'high' : 'medium',
      title: 'Fix connector readiness',
      summary: `${item.connector.name}: ${item.readiness.summary}`,
      href: '/connectors',
      evidence: item.readiness.checks
        .filter((check) => check.status !== 'ready')
        .map((check) => `${check.label}: ${check.detail}`),
      createdAt: item.connector.updatedAt || item.connector.createdAt,
    })
  }

  for (const item of gatewayAttention.slice(0, 5)) {
    addAction(actions, {
      id: `gateway:${item.gateway.id}`,
      kind: 'gateway',
      severity: item.reason.severity,
      title: 'Review OpenClaw gateway',
      summary: item.reason.summary,
      href: '/providers',
      evidence: item.reason.evidence,
      createdAt: item.gateway.stats?.lastTopologyCheckedAt || item.gateway.lastCheckedAt || item.gateway.updatedAt || item.gateway.createdAt,
    })
  }

  for (const item of budgetWarnings.slice(0, 5)) {
    if (!item.pressure) continue
    addAction(actions, {
      id: `budget:${item.mission.id}:${item.pressure.label}`,
      kind: 'budget',
      severity: item.pressure.fraction >= 0.95 ? 'high' : 'medium',
      title: 'Check mission budget',
      summary: `${item.mission.title} is at ${percent(item.pressure.fraction)} of its ${item.pressure.label} budget.`,
      href: `/missions?mission=${encodeURIComponent(item.mission.id)}`,
      evidence: [`status:${item.mission.status}`, `goal:${item.mission.goal}`],
      createdAt: item.mission.updatedAt || item.mission.createdAt,
    })
  }

  for (const mission of activeMissions.slice(0, 3)) {
    addAction(actions, {
      id: `mission:${mission.id}`,
      kind: 'mission',
      severity: mission.status === 'paused' ? 'medium' : 'low',
      title: mission.status === 'paused' ? 'Resume or close paused mission' : 'Monitor active mission',
      summary: mission.title,
      href: `/missions?mission=${encodeURIComponent(mission.id)}`,
      evidence: [`${mission.usage.turnsRun} turns`, `${mission.usage.tokensUsed.toLocaleString()} tokens`],
      createdAt: mission.updatedAt || mission.createdAt,
    })
  }

  return {
    generatedAt: input.now,
    range: input.range,
    windowStart,
    kpis: {
      activeMissions: activeMissions.length,
      runningRuns: runningRuns.length,
      failedRuns: failedRuns.length,
      pendingApprovals: pendingApprovals.length,
      connectorAttention: connectorAttention.length,
      gatewayAttention: gatewayAttention.length,
      budgetWarnings: budgetWarnings.length,
    },
    actions: sortActions(actions),
  }
}

export function getOperationPulse(range: OperationPulseRange): OperationPulse {
  const now = Date.now()
  return buildOperationPulse({
    range,
    now,
    missions: listMissions(),
    runs: listUnifiedRuns({ limit: 500 }),
    approvals: listPendingApprovals(),
    connectors: Object.values(loadConnectors()),
    gateways: listOpenClawGatewayProfiles(),
  })
}
