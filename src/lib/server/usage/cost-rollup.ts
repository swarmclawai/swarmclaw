import type { Agent } from '@/types'
import { patchAgent } from '@/lib/server/agents/agent-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import { notify } from '@/lib/server/ws-hub'
import { log } from '@/lib/server/logger'

const TAG = 'cost-rollup'

const ONE_HOUR_MS = 60 * 60 * 1000

function toWindowBoundaries(now: number) {
  const d = new Date(now)
  const dayStart = new Date(d)
  dayStart.setUTCHours(0, 0, 0, 0)
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  return {
    hourStartTs: now - ONE_HOUR_MS,
    dayStartTs: dayStart.getTime(),
    monthStartTs: monthStart.getTime(),
  }
}

/**
 * Push-based cost rollup: atomically increments the agent's persisted spend
 * fields and checks budgets. Called immediately after each usage record is appended.
 */
export function rollupCostToAgent(agentId: string, costUsd: number): void {
  if (!agentId || !Number.isFinite(costUsd) || costUsd <= 0) return

  const now = Date.now()
  const costCents = Math.round(costUsd * 100)
  const { hourStartTs, dayStartTs, monthStartTs } = toWindowBoundaries(now)

  const updated = patchAgent(agentId, (current) => {
    if (!current) return null
    const lastRollup = current.lastSpendRollupAt ?? 0
    const lastBounds = toWindowBoundaries(lastRollup)

    // Reset windows that have rolled over since last rollup
    let hourly = current.spentHourlyCents ?? 0
    let daily = current.spentDailyCents ?? 0
    let monthly = current.spentMonthlyCents ?? 0

    if (lastRollup < hourStartTs) hourly = 0
    if (lastBounds.dayStartTs < dayStartTs) daily = 0
    if (lastBounds.monthStartTs < monthStartTs) monthly = 0

    return {
      ...current,
      spentHourlyCents: hourly + costCents,
      spentDailyCents: daily + costCents,
      spentMonthlyCents: monthly + costCents,
      lastSpendRollupAt: now,
    }
  })

  if (!updated) return

  // Check budgets and enforce
  checkAndEnforceBudget(updated)
}

/**
 * Checks agent's persisted spend against configured budgets and logs
 * activity entries when thresholds are hit.
 */
function checkAndEnforceBudget(agent: Agent): void {
  const WARNING_RATIO = 0.8

  const windows = [
    { key: 'hourly' as const, budget: agent.hourlyBudget, spent: (agent.spentHourlyCents ?? 0) / 100 },
    { key: 'daily' as const, budget: agent.dailyBudget, spent: (agent.spentDailyCents ?? 0) / 100 },
    { key: 'monthly' as const, budget: agent.monthlyBudget, spent: (agent.spentMonthlyCents ?? 0) / 100 },
  ]

  for (const { key, budget, spent } of windows) {
    if (!budget || !Number.isFinite(budget) || budget <= 0) continue
    const ratio = spent / budget

    if (ratio >= 1) {
      log.warn(TAG, `Agent "${agent.name}" exceeded ${key} budget: $${spent.toFixed(4)} / $${budget.toFixed(2)}`)
      logActivity({
        entityType: 'budget',
        entityId: agent.id,
        action: 'budget_exceeded',
        actor: 'system',
        summary: `Agent "${agent.name}" exceeded ${key} budget: $${spent.toFixed(4)} / $${budget.toFixed(2)}`,
        detail: { window: key, spent, budget, ratio },
      })
      notify('agents')
    } else if (ratio >= WARNING_RATIO) {
      logActivity({
        entityType: 'budget',
        entityId: agent.id,
        action: 'budget_warning',
        actor: 'system',
        summary: `Agent "${agent.name}" nearing ${key} budget: $${spent.toFixed(4)} / $${budget.toFixed(2)} (${Math.round(ratio * 100)}%)`,
        detail: { window: key, spent, budget, ratio },
      })
    }
  }
}

/**
 * Reset all agents' daily spend counters. Call at UTC midnight.
 */
export function resetDailySpends(agents: Record<string, Agent>): void {
  for (const agent of Object.values(agents)) {
    if ((agent.spentDailyCents ?? 0) > 0) {
      patchAgent(agent.id, (current) => current ? { ...current, spentDailyCents: 0 } : null)
    }
  }
}

/**
 * Reset all agents' monthly spend counters. Call at UTC month boundary.
 */
export function resetMonthlySpends(agents: Record<string, Agent>): void {
  for (const agent of Object.values(agents)) {
    if ((agent.spentMonthlyCents ?? 0) > 0) {
      patchAgent(agent.id, (current) => current ? { ...current, spentMonthlyCents: 0 } : null)
    }
  }
}
