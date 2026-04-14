import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Mission } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let service: typeof import('./mission-service')
let hook: typeof import('./mission-budget-hook')
let repo: typeof import('./mission-repository')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-mission-svc-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  service = await import('./mission-service')
  hook = await import('./mission-budget-hook')
  repo = await import('./mission-repository')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createDraft(sessionId: string, overrides: Partial<Parameters<typeof service.createMission>[0]> = {}): Mission {
  return service.createMission({
    title: 'Smoke',
    goal: 'Do the thing',
    rootSessionId: sessionId,
    agentIds: ['a1'],
    ...overrides,
  })
}

describe('mission-service: lifecycle', () => {
  it('creates a draft mission with zeroed usage', () => {
    const m = createDraft('svc_s_1')
    assert.equal(m.status, 'draft')
    assert.equal(m.usage.usdSpent, 0)
    assert.equal(m.usage.turnsRun, 0)
    assert.equal(m.usage.startedAt, null)
    assert.deepEqual(m.budget.warnAtFractions, [0.5, 0.8, 0.95])
  })

  it('startMission transitions draft to running, sets startedAt, records milestone', () => {
    const m = createDraft('svc_s_2')
    const started = service.startMission(m.id)
    assert.equal(started?.status, 'running')
    assert.ok((started?.usage.startedAt ?? 0) > 0)
    assert.equal(started?.milestones[0]?.kind, 'started')
  })

  it('pauseMission transitions running to paused', () => {
    const m = createDraft('svc_s_3')
    service.startMission(m.id)
    const paused = service.pauseMission(m.id, 'checking in')
    assert.equal(paused?.status, 'paused')
  })

  it('cancelMission records endReason and stops', () => {
    const m = createDraft('svc_s_4')
    service.startMission(m.id)
    const cancelled = service.cancelMission(m.id, 'user stop')
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(cancelled?.endReason, 'user stop')
    assert.ok((cancelled?.endedAt ?? 0) > 0)
  })

  it('completeMission transitions to completed', () => {
    const m = createDraft('svc_s_5')
    service.startMission(m.id)
    const done = service.completeMission(m.id, 'goal met')
    assert.equal(done?.status, 'completed')
  })
})

describe('mission-service: budget evaluation', () => {
  it('allows when under all caps', () => {
    const m = createDraft('svc_b_1', { budget: { maxUsd: 1, maxTokens: 1000, maxTurns: 5 } })
    const started = service.startMission(m.id)!
    const verdict = service.evaluateMissionBudget(started)
    assert.equal(verdict.allow, true)
  })

  it('denies when USD cap is hit', () => {
    const m = createDraft('svc_b_2', { budget: { maxUsd: 0.1 } })
    service.startMission(m.id)
    service.recordTurnUsage(m.id, { usdDelta: 0.15, turnsDelta: 1 })
    const latest = repo.getMission(m.id)!
    const verdict = service.evaluateMissionBudget(latest)
    assert.equal(verdict.allow, false)
    assert.equal(verdict.hitCap, 'usd')
  })

  it('denies when max turns is reached', () => {
    const m = createDraft('svc_b_3', { budget: { maxTurns: 2 } })
    service.startMission(m.id)
    service.recordTurnUsage(m.id, { turnsDelta: 2 })
    const latest = repo.getMission(m.id)!
    const verdict = service.evaluateMissionBudget(latest)
    assert.equal(verdict.allow, false)
    assert.equal(verdict.hitCap, 'turns')
  })

  it('denies when wallclock budget is exceeded', () => {
    const m = createDraft('svc_b_4', { budget: { maxWallclockSec: 60 } })
    service.startMission(m.id)
    const now = Date.now()
    const fakeFuture = now + 61_000
    const latest = repo.getMission(m.id)!
    const verdict = service.evaluateMissionBudget(latest, fakeFuture)
    assert.equal(verdict.allow, false)
    assert.equal(verdict.hitCap, 'wallclock')
  })

  it('fires a budget_warn milestone at the crossed threshold', () => {
    const m = createDraft('svc_b_5', { budget: { maxTurns: 10, warnAtFractions: [0.5] } })
    service.startMission(m.id)
    service.recordTurnUsage(m.id, { turnsDelta: 5 })
    const latest = repo.getMission(m.id)!
    assert.ok(latest.usage.warnFractionsHit.includes(0.5))
    const warn = latest.milestones.find((ms) => ms.kind === 'budget_warn')
    assert.ok(warn, 'expected a budget_warn milestone')
  })

  it('does not fire the same warn threshold twice', () => {
    const m = createDraft('svc_b_6', { budget: { maxTurns: 10, warnAtFractions: [0.5] } })
    service.startMission(m.id)
    service.recordTurnUsage(m.id, { turnsDelta: 5 })
    service.recordTurnUsage(m.id, { turnsDelta: 1 })
    const latest = repo.getMission(m.id)!
    const warnCount = latest.milestones.filter((ms) => ms.kind === 'budget_warn').length
    assert.equal(warnCount, 1)
  })
})

describe('mission-budget-hook', () => {
  it('allows when missionId is null', () => {
    const verdict = hook.checkMissionBudgetForSession(null)
    assert.equal(verdict.allow, true)
  })

  it('allows when mission does not exist', () => {
    const verdict = hook.checkMissionBudgetForSession('does-not-exist')
    assert.equal(verdict.allow, true)
  })

  it('denies when mission is in draft status', () => {
    const m = createDraft('svc_h_1')
    const verdict = hook.checkMissionBudgetForSession(m.id)
    assert.equal(verdict.allow, false)
  })

  it('allows when mission is running and under budget', () => {
    const m = createDraft('svc_h_2', { budget: { maxTurns: 10 } })
    service.startMission(m.id)
    const verdict = hook.checkMissionBudgetForSession(m.id)
    assert.equal(verdict.allow, true)
  })

  it('transitions mission to budget_exhausted when cap is hit', () => {
    const m = createDraft('svc_h_3', { budget: { maxTurns: 1 } })
    service.startMission(m.id)
    service.recordTurnUsage(m.id, { turnsDelta: 1 })
    const verdict = hook.checkMissionBudgetForSession(m.id)
    assert.equal(verdict.allow, false)
    const latest = repo.getMission(m.id)!
    assert.equal(latest.status, 'budget_exhausted')
    assert.ok(latest.endedAt)
  })

  it('session-to-mission map tracks running mission', () => {
    const m = createDraft('svc_map_1')
    service.startMission(m.id)
    const resolved = service.getMissionIdForSession('svc_map_1')
    assert.equal(resolved, m.id)
  })

  it('session-to-mission map clears after mission ends', () => {
    const m = createDraft('svc_map_2')
    service.startMission(m.id)
    service.completeMission(m.id)
    const resolved = service.getMissionIdForSession('svc_map_2')
    assert.equal(resolved, null)
  })
})
