import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let storage: typeof import('@/lib/server/storage')
let lifecycle: typeof import('@/lib/server/schedules/schedule-lifecycle')

function makeSchedule(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: 'sched-1',
    name: 'Morning ferry reminder',
    agentId: 'agent-1',
    taskPrompt: 'Send the ferry reminder',
    scheduleType: 'interval' as const,
    intervalMs: 60_000,
    status: 'active' as const,
    linkedTaskId: 'task-1',
    createdAt: now,
    updatedAt: now,
    nextRunAt: now + 60_000,
    ...overrides,
  }
}

function makeTask(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: 'task-1',
    title: '[Sched] Morning ferry reminder',
    description: 'Send the ferry reminder',
    status: 'queued' as const,
    agentId: 'agent-1',
    sourceType: 'schedule',
    sourceScheduleId: 'sched-1',
    sourceScheduleName: 'Morning ferry reminder',
    sessionId: 'session-1',
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    ...overrides,
  }
}

function makeSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: 'session-1',
    name: 'Task Session',
    cwd: workspaceDir,
    user: 'system',
    provider: 'openai',
    model: 'gpt-test',
    credentialId: null,
    apiEndpoint: null,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    sessionType: 'human',
    agentId: 'agent-1',
    plugins: [],
    heartbeatEnabled: true,
    ...overrides,
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-schedule-life-'))
  workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  storage = await import('@/lib/server/storage')
  lifecycle = await import('@/lib/server/schedules/schedule-lifecycle')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('schedule lifecycle helpers', () => {
  it('archives a schedule and cancels linked queued work', () => {
    storage.saveSchedules({ 'sched-1': makeSchedule() })
    storage.saveTasks({ 'task-1': makeTask() })
    storage.saveSessions({ 'session-1': makeSession() })
    storage.saveQueue(['task-1'])

    const now = Date.now()
    const result = lifecycle.archiveScheduleCluster('sched-1', { now, actor: { actor: 'user' } })

    assert.equal(result.ok, true)
    assert.deepEqual(result.archivedIds, ['sched-1'])
    assert.deepEqual(result.cancelledTaskIds, ['task-1'])

    const schedules = storage.loadSchedules()
    const tasks = storage.loadTasks()
    const queue = storage.loadQueue()
    const sessions = storage.loadSessions()

    assert.equal(schedules['sched-1'].status, 'archived')
    assert.equal(schedules['sched-1'].archivedFromStatus, 'active')
    assert.equal(schedules['sched-1'].nextRunAt, undefined)
    assert.equal(tasks['task-1'].status, 'cancelled')
    assert.equal(tasks['task-1'].retryScheduledAt, null)
    assert.deepEqual(queue, [])
    assert.equal(sessions['session-1'].heartbeatEnabled, false)
  })

  it('restores an archived schedule to its previous status and recomputes its next run', () => {
    const now = Date.now()
    storage.saveSchedules({
      'sched-restore': makeSchedule({
        id: 'sched-restore',
        status: 'archived',
        archivedAt: now - 5_000,
        archivedFromStatus: 'active',
        nextRunAt: undefined,
      }),
    })

    const result = lifecycle.restoreArchivedScheduleCluster('sched-restore', { now, actor: { actor: 'user' } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.restoredIds, ['sched-restore'])

    const restored = storage.loadSchedules()['sched-restore']
    assert.equal(restored.status, 'active')
    assert.equal(restored.archivedAt, undefined)
    assert.equal(restored.archivedFromStatus, undefined)
    assert.equal(typeof restored.nextRunAt, 'number')
    assert.ok((restored.nextRunAt || 0) > now)
  })

  it('purges archived schedules and rejects purging live schedules', () => {
    storage.saveSchedules({
      'sched-archived': makeSchedule({
        id: 'sched-archived',
        status: 'archived',
        archivedAt: Date.now(),
        archivedFromStatus: 'active',
        nextRunAt: undefined,
      }),
      'sched-live': makeSchedule({
        id: 'sched-live',
        status: 'active',
      }),
    })

    const liveResult = lifecycle.purgeArchivedScheduleCluster('sched-live', { actor: { actor: 'user' } })
    assert.equal(liveResult.ok, false)

    const archivedResult = lifecycle.purgeArchivedScheduleCluster('sched-archived', { actor: { actor: 'user' } })
    assert.equal(archivedResult.ok, true)
    assert.deepEqual(archivedResult.purgedIds, ['sched-archived'])

    const schedules = storage.loadSchedules()
    assert.equal(Boolean(schedules['sched-archived']), false)
    assert.equal(Boolean(schedules['sched-live']), true)
  })
})
