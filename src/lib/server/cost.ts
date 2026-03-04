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
  'o3': [10, 40],
  'o3-mini': [1.1, 4.4],
  'o4-mini': [1.1, 4.4],
  // OpenAI embeddings
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
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

// --- Agent Monthly Budget ---

import { loadUsage, loadSessions } from './storage'
import type { Agent, UsageRecord } from '@/types'

/**
 * Sum the estimated cost for an agent in the current calendar month.
 * Usage records are keyed by sessionId; we resolve agentId through sessions.
 */
export function getAgentMonthlySpend(agentId: string): number {
  const sessions = loadSessions()
  // Build a set of sessionIds linked to this agent
  const agentSessionIds = new Set<string>()
  for (const [sid, session] of Object.entries(sessions)) {
    if (session?.agentId === agentId) agentSessionIds.add(sid)
  }
  if (agentSessionIds.size === 0) return 0

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const usage = loadUsage()
  let total = 0
  for (const sid of agentSessionIds) {
    const records = usage[sid]
    if (!Array.isArray(records)) continue
    for (const record of records) {
      const r = record as UsageRecord
      if (typeof r.timestamp !== 'number' || r.timestamp < monthStart) continue
      if (typeof r.estimatedCost === 'number' && Number.isFinite(r.estimatedCost) && r.estimatedCost > 0) {
        total += r.estimatedCost
      }
    }
  }
  return total
}

export interface BudgetCheckResult {
  ok: boolean
  spend: number
  budget: number
  message?: string
}

/**
 * Check whether an agent is within its monthly budget.
 * Returns ok: true if no budget is set or spend is under the cap.
 */
export function checkBudget(agent: Agent): BudgetCheckResult {
  const budget = typeof agent.monthlyBudget === 'number' && Number.isFinite(agent.monthlyBudget) && agent.monthlyBudget > 0
    ? agent.monthlyBudget
    : 0

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
