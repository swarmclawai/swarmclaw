import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@/types'
import { checkAgentBudgetLimits, getAgentSpendWindows } from './cost'

function buildNowTs(): number {
  const d = new Date()
  d.setFullYear(2026, 2, 15)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

test('getAgentSpendWindows aggregates hourly/daily/monthly windows', () => {
  const now = buildNowTs()
  const previousMonth = new Date(2026, 1, 20, 12, 0, 0, 0).getTime()

  const sessions = {
    s1: { agentId: 'agent-a' },
    s2: { agentId: 'agent-b' },
  }
  const usage = {
    s1: [
      { timestamp: now - 20 * 60_000, estimatedCost: 1.25 },      // within hour
      { timestamp: now - 3 * 60 * 60_000, estimatedCost: 0.5 },    // today
      { timestamp: now - 26 * 60 * 60_000, estimatedCost: 2.0 },   // yesterday
      { timestamp: previousMonth, estimatedCost: 4.0 },            // previous month
    ],
    s2: [
      { timestamp: now - 5 * 60_000, estimatedCost: 99 },          // different agent
    ],
  }

  const spend = getAgentSpendWindows('agent-a', now, { sessions, usage })
  assert.equal(spend.hourly, 1.25)
  assert.equal(spend.daily, 1.75)
  assert.equal(spend.monthly, 3.75)
})

test('checkAgentBudgetLimits reports exceeded and warning windows', () => {
  const now = buildNowTs()
  const sessions = { s1: { agentId: 'agent-a' } }
  const usage = {
    s1: [
      { timestamp: now - 15 * 60_000, estimatedCost: 1.25 },       // hourly over
      { timestamp: now - 4 * 60 * 60_000, estimatedCost: 0.5 },    // daily near
      { timestamp: now - 26 * 60 * 60_000, estimatedCost: 2.0 },   // monthly near
    ],
  }
  const agent = {
    id: 'agent-a',
    name: 'Agent A',
    hourlyBudget: 1.0,
    dailyBudget: 2.0,
    monthlyBudget: 4.0,
  } as Agent

  const result = checkAgentBudgetLimits(agent, now, { sessions, usage })
  assert.equal(result.ok, false)
  assert.deepEqual(result.exceeded.map((x) => x.window), ['hourly'])
  assert.deepEqual(result.warnings.map((x) => x.window), ['daily', 'monthly'])
})

test('checkAgentBudgetLimits is ok when no caps are configured', () => {
  const now = buildNowTs()
  const sessions = { s1: { agentId: 'agent-a' } }
  const usage = { s1: [{ timestamp: now - 10 * 60_000, estimatedCost: 10 }] }
  const agent = { id: 'agent-a', name: 'Agent A' } as Agent

  const result = checkAgentBudgetLimits(agent, now, { sessions, usage })
  assert.equal(result.ok, true)
  assert.equal(result.exceeded.length, 0)
  assert.equal(result.warnings.length, 0)
})
