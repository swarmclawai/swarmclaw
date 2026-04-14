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
let repo: typeof import('./mission-repository')

function makeMission(overrides: Partial<Mission> = {}): Mission {
  const now = Date.now()
  return {
    id: overrides.id ?? 'mi_test_1',
    title: 'Smoke mission',
    goal: 'Write 3 haikus about budgets',
    successCriteria: ['File haikus.md has 3 stanzas'],
    rootSessionId: 's1',
    agentIds: ['a1'],
    status: 'draft',
    budget: {
      maxUsd: 0.1,
      maxTokens: 5000,
      maxToolCalls: null,
      maxWallclockSec: 600,
      maxTurns: 20,
      warnAtFractions: [0.5, 0.8, 0.95],
    },
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
    reportSchedule: null,
    reportConnectorIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-missions-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
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

describe('mission-repository', () => {
  it('persists and retrieves a mission', () => {
    const mission = makeMission({ id: 'mi_persist_1' })
    repo.upsertMission(mission)
    const fetched = repo.getMission('mi_persist_1')
    assert.ok(fetched)
    assert.equal(fetched?.title, 'Smoke mission')
    assert.equal(fetched?.status, 'draft')
  })

  it('lists missions newest-first', () => {
    const older = makeMission({ id: 'mi_list_old', createdAt: 1_000 })
    const newer = makeMission({ id: 'mi_list_new', createdAt: 2_000 })
    repo.upsertMission(older)
    repo.upsertMission(newer)
    const all = repo.listMissions()
    const olderIdx = all.findIndex((m) => m.id === 'mi_list_old')
    const newerIdx = all.findIndex((m) => m.id === 'mi_list_new')
    assert.ok(newerIdx >= 0 && olderIdx >= 0)
    assert.ok(newerIdx < olderIdx, 'newer mission should appear before older')
  })

  it('patches a mission and bumps updatedAt', async () => {
    const mission = makeMission({ id: 'mi_patch_1', updatedAt: 1_000 })
    repo.upsertMission(mission)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const patched = repo.patchMission('mi_patch_1', (m) => {
      if (!m) return null
      return { ...m, status: 'running' }
    })
    assert.ok(patched)
    assert.equal(patched?.status, 'running')
    assert.ok((patched?.updatedAt ?? 0) > 1_000)
  })

  it('appends milestones with cap and writes an event', () => {
    const mission = makeMission({ id: 'mi_milestone_1' })
    repo.upsertMission(mission)
    repo.appendMissionMilestone('mi_milestone_1', {
      kind: 'started',
      summary: 'Mission started',
    })
    const fetched = repo.getMission('mi_milestone_1')
    assert.equal(fetched?.milestones.length, 1)
    assert.equal(fetched?.milestones[0].kind, 'started')
    const events = repo.listMissionEvents('mi_milestone_1')
    assert.ok(events.some((e) => e.kind === 'milestone:started'))
  })

  it('caps milestone tail at the configured maximum', () => {
    const mission = makeMission({ id: 'mi_cap_1' })
    repo.upsertMission(mission)
    for (let i = 0; i < 205; i++) {
      repo.appendMissionMilestone('mi_cap_1', {
        kind: 'check_in',
        summary: `check ${i}`,
      })
    }
    const fetched = repo.getMission('mi_cap_1')
    assert.equal(fetched?.milestones.length, 200)
    // Oldest retained should be check 5 (first five were trimmed)
    assert.equal(fetched?.milestones[0].summary, 'check 5')
    assert.equal(fetched?.milestones[199].summary, 'check 204')
  })

  it('saves and lists reports newest-first', () => {
    const mission = makeMission({ id: 'mi_report_1' })
    repo.upsertMission(mission)
    const now = Date.now()
    repo.saveMissionReport({
      id: 'mrep_1',
      missionId: 'mi_report_1',
      generatedAt: now - 1000,
      format: 'markdown',
      fromAt: now - 2000,
      toAt: now - 1000,
      title: 'First report',
      body: 'body 1',
      deliveredTo: [],
      highlights: [],
    })
    repo.saveMissionReport({
      id: 'mrep_2',
      missionId: 'mi_report_1',
      generatedAt: now,
      format: 'markdown',
      fromAt: now - 1000,
      toAt: now,
      title: 'Second report',
      body: 'body 2',
      deliveredTo: [],
      highlights: [],
    })
    const reports = repo.listMissionReports('mi_report_1')
    assert.equal(reports.length, 2)
    assert.equal(reports[0].id, 'mrep_2')
    assert.equal(reports[1].id, 'mrep_1')
  })
})
