import type { Agent, UsageRecord, PluginDefinitionCost } from '@/types'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { loadSessions, loadUsage } from './storage'

// Model cost table: [inputCostPer1M, outputCostPer1M] in USD
const MODEL_COSTS: Record<string, [number, number]> = {
  // Anthropic
  'claude-opus-4-6': [15, 75],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5-20251001': [0.8, 4],
  'claude-sonnet-4-5-20250514': [3, 15],
  // OpenAI
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  o3: [10, 40],
  'o3-mini': [1.1, 4.4],
  'o4-mini': [1.1, 4.4],
  // OpenAI embeddings
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
}

const ONE_HOUR_MS = 60 * 60 * 1000
const WARNING_RATIO = 0.8

type GenericRecord = Record<string, unknown>
type SessionsMap = Record<string, GenericRecord>
type UsageMap = Record<string, unknown>

function parsePositiveBudget(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

function toDateBoundaries(now: number) {
  const d = new Date(now)
  const dayStart = new Date(d)
  dayStart.setHours(0, 0, 0, 0)
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1)
  return {
    hourStartTs: now - ONE_HOUR_MS,
    dayStartTs: dayStart.getTime(),
    monthStartTs: monthStart.getTime(),
  }
}

function getAgentSessionIds(agentId: string, sessions: SessionsMap): Set<string> {
  const ids = new Set<string>()
  for (const [sid, session] of Object.entries(sessions)) {
    if (session?.agentId === agentId) ids.add(sid)
  }
  return ids
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const costs = MODEL_COSTS[model]
  if (!costs) return 0
  const [inputRate, outputRate] = costs
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
}

export function getModelCosts(): Record<string, [number, number]> {
  return { ...MODEL_COSTS }
}

/**
 * Estimate the number of tokens a tool definition occupies in the LLM context.
 * Uses ~4 chars per token as a rough approximation.
 */
export function estimateToolDefinitionTokens(t: StructuredToolInterface): number {
  let chars = (t.name || '').length + (t.description || '').length
  try {
    const schema = typeof t.schema === 'object' ? JSON.stringify(t.schema) : ''
    chars += schema.length
  } catch { /* ignore */ }
  return Math.ceil(chars / 4)
}

/**
 * Build per-plugin definition cost estimates from a set of tools and their plugin mapping.
 */
export function buildPluginDefinitionCosts(
  tools: StructuredToolInterface[],
  toolToPluginMap: Record<string, string>,
): PluginDefinitionCost[] {
  const totals = new Map<string, number>()
  for (const t of tools) {
    const pluginId = toolToPluginMap[t.name] || '_unknown'
    const tokens = estimateToolDefinitionTokens(t)
    totals.set(pluginId, (totals.get(pluginId) || 0) + tokens)
  }
  return Array.from(totals.entries()).map(([pluginId, estimatedTokens]) => ({
    pluginId,
    estimatedTokens,
  }))
}

export interface AgentSpendWindows {
  hourly: number
  daily: number
  monthly: number
}

export function getAgentSpendWindows(
  agentId: string,
  now = Date.now(),
  opts?: { sessions?: SessionsMap; usage?: UsageMap },
): AgentSpendWindows {
  const sessions = opts?.sessions ?? (loadSessions() as SessionsMap)
  const usage = opts?.usage ?? (loadUsage() as UsageMap)
  const agentSessionIds = getAgentSessionIds(agentId, sessions)
  if (agentSessionIds.size === 0) {
    return { hourly: 0, daily: 0, monthly: 0 }
  }

  const { hourStartTs, dayStartTs, monthStartTs } = toDateBoundaries(now)
  const spend: AgentSpendWindows = { hourly: 0, daily: 0, monthly: 0 }

  for (const sid of agentSessionIds) {
    const raw = usage[sid]
    if (!Array.isArray(raw)) continue
    for (const record of raw) {
      const r = record as UsageRecord
      const ts = typeof r?.timestamp === 'number' ? r.timestamp : 0
      if (ts <= 0) continue
      const cost = typeof r?.estimatedCost === 'number' ? r.estimatedCost : 0
      if (!Number.isFinite(cost) || cost <= 0) continue

      if (ts >= monthStartTs) spend.monthly += cost
      if (ts >= dayStartTs) spend.daily += cost
      if (ts >= hourStartTs) spend.hourly += cost
    }
  }

  return spend
}

export function getAgentMonthlySpend(
  agentId: string,
  now = Date.now(),
  opts?: { sessions?: SessionsMap; usage?: UsageMap },
): number {
  return getAgentSpendWindows(agentId, now, opts).monthly
}

export function getAgentDailySpend(
  agentId: string,
  now = Date.now(),
  opts?: { sessions?: SessionsMap; usage?: UsageMap },
): number {
  return getAgentSpendWindows(agentId, now, opts).daily
}

export function getAgentHourlySpend(
  agentId: string,
  now = Date.now(),
  opts?: { sessions?: SessionsMap; usage?: UsageMap },
): number {
  return getAgentSpendWindows(agentId, now, opts).hourly
}

export type AgentBudgetWindow = 'hourly' | 'daily' | 'monthly'

export interface AgentBudgetStatus {
  window: AgentBudgetWindow
  spend: number
  budget: number
  ratio: number
  message: string
}

export interface AgentBudgetCheckSummary {
  ok: boolean
  spend: AgentSpendWindows
  exceeded: AgentBudgetStatus[]
  warnings: AgentBudgetStatus[]
}

function budgetWindowLabel(window: AgentBudgetWindow): string {
  if (window === 'hourly') return 'hourly'
  if (window === 'daily') return 'daily'
  return 'monthly'
}

function buildBudgetStatus(
  agentName: string,
  window: AgentBudgetWindow,
  spend: number,
  budget: number,
  exceeded: boolean,
): AgentBudgetStatus {
  const ratio = budget > 0 ? spend / budget : 0
  const label = budgetWindowLabel(window)
  const message = exceeded
    ? `Agent "${agentName}" has reached its ${label} budget: $${spend.toFixed(4)} spent of $${budget.toFixed(2)} cap.`
    : `Agent "${agentName}" is nearing its ${label} budget: $${spend.toFixed(4)} of $${budget.toFixed(2)} (${Math.round(ratio * 100)}%).`
  return { window, spend, budget, ratio, message }
}

export function checkAgentBudgetLimits(
  agent: Agent,
  now = Date.now(),
  opts?: { sessions?: SessionsMap; usage?: UsageMap },
): AgentBudgetCheckSummary {
  const budgets: Partial<Record<AgentBudgetWindow, number>> = {
    hourly: parsePositiveBudget(agent.hourlyBudget) ?? undefined,
    daily: parsePositiveBudget(agent.dailyBudget) ?? undefined,
    monthly: parsePositiveBudget(agent.monthlyBudget) ?? undefined,
  }
  const spend = getAgentSpendWindows(agent.id, now, opts)
  const exceeded: AgentBudgetStatus[] = []
  const warnings: AgentBudgetStatus[] = []

  for (const window of ['hourly', 'daily', 'monthly'] as const) {
    const budget = budgets[window]
    if (!budget) continue
    const windowSpend = spend[window]
    if (windowSpend >= budget) {
      exceeded.push(buildBudgetStatus(agent.name, window, windowSpend, budget, true))
      continue
    }
    if (windowSpend >= budget * WARNING_RATIO) {
      warnings.push(buildBudgetStatus(agent.name, window, windowSpend, budget, false))
    }
  }

  return {
    ok: exceeded.length === 0,
    spend,
    exceeded,
    warnings,
  }
}

export interface BudgetCheckResult {
  ok: boolean
  spend: number
  budget: number
  message?: string
}

/**
 * Backwards-compatible monthly-only budget check.
 */
export function checkBudget(agent: Agent): BudgetCheckResult {
  const budget = parsePositiveBudget(agent.monthlyBudget) ?? 0
  if (budget <= 0) {
    return { ok: true, spend: 0, budget: 0 }
  }

  const spend = getAgentMonthlySpend(agent.id)
  if (spend >= budget) {
    return {
      ok: false,
      spend,
      budget,
      message: `Agent "${agent.name}" has reached its monthly budget: $${spend.toFixed(4)} spent of $${budget.toFixed(2)} cap.`,
    }
  }

  return { ok: true, spend, budget }
}
