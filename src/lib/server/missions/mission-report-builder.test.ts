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
let builder: typeof import('./mission-report-builder')
let service: typeof import('./mission-service')
let repo: typeof import('./mission-repository')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-report-builder-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  builder = await import('./mission-report-builder')
  service = await import('./mission-service')
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

function makeRunningMission(label: string): Mission {
  const m = service.createMission({
    title: `Test report mission ${label}`,
    goal: 'Write haikus',
    successCriteria: ['3 haikus saved', 'Each 5-7-5'],
    rootSessionId: `rep_s_${label}`,
    agentIds: ['a1'],
    budget: { maxUsd: 0.5, maxTokens: 5000, maxTurns: 10, maxWallclockSec: 600 },
  })
  const started = service.startMission(m.id)
  return started ?? m
}

describe('mission-report-builder', () => {
  it('builds a markdown progress report with usage and milestones', () => {
    const m = makeRunningMission('rep_1')
    service.recordTurnUsage(m.id, { turnsDelta: 2, tokensDelta: 500, usdDelta: 0.05 })
    repo.appendMissionMilestone(m.id, { kind: 'subgoal_done', summary: 'Haiku one drafted' })
    const latest = repo.getMission(m.id)!
    const { report, deliveryTitle, deliveryMessage } = builder.buildMissionReport(latest, {
      from: latest.createdAt,
      to: Date.now(),
    })
    assert.ok(report.body.includes('# Test report mission rep_1: progress update'))
    assert.ok(report.body.includes('**Goal**: Write haikus'))
    assert.ok(report.body.includes('Turns run: 2 / 10'))
    assert.ok(report.body.includes('Tokens used: 500 / 5000'))
    assert.ok(report.body.includes('Spend: $0.05 / $0.50'))
    assert.ok(report.body.includes('3 haikus saved'))
    assert.ok(report.body.includes('Milestones'))
    assert.ok(report.body.includes('Haiku one drafted'))
    assert.equal(report.format, 'markdown')
    assert.equal(report.missionId, m.id)
    assert.ok(deliveryTitle.includes('Test report mission'))
    assert.ok(deliveryMessage.includes('still running'))
  })

  it('builds a final report when isFinal is set, including end reason', () => {
    const m = makeRunningMission('rep_2')
    service.cancelMission(m.id, 'user aborted')
    const cancelled = repo.getMission(m.id)!
    const { report, deliveryMessage } = builder.buildMissionReport(cancelled, {
      from: cancelled.createdAt,
      to: Date.now(),
    }, { isFinal: true })
    assert.ok(report.body.includes('final report'))
    assert.ok(report.body.includes('## End reason'))
    assert.ok(report.body.includes('user aborted'))
    assert.ok(deliveryMessage.includes('has ended'))
  })

  it('includes up to the last N milestones when the list is long', () => {
    const m = makeRunningMission('rep_3')
    for (let i = 0; i < 25; i++) {
      repo.appendMissionMilestone(m.id, { kind: 'check_in', summary: `check ${i}` })
    }
    const latest = repo.getMission(m.id)!
    const { report } = builder.buildMissionReport(latest, {
      from: 0,
      to: Date.now(),
    })
    // Body should mention the last check (24), but capped at 20 listed
    assert.ok(report.body.includes('check 24'))
    const milestoneLines = report.body.split('\n').filter((l) => l.includes('**check_in**'))
    assert.ok(milestoneLines.length <= 20)
  })
})
