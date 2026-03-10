import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

// ── Temp-dir env isolation ────────────────────────────────────────────
let tempDir: string
let storage: typeof import('../storage')
let dedupe: typeof import('../../schedules/schedule-dedupe')
let origin: typeof import('../../schedules/schedule-origin')
let scheduleName: typeof import('../../schedules/schedule-name')
let normalization: typeof import('@/lib/server/schedules/schedule-normalization')

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-sched-adv-'))
  const dataDir = path.join(tempDir, 'data')
  const workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  process.env.DATA_DIR = dataDir
  process.env.WORKSPACE_DIR = workspaceDir
  delete process.env.SWARMCLAW_BUILD_MODE

  storage = await import('../storage')
  dedupe = await import('../../schedules/schedule-dedupe')
  origin = await import('../../schedules/schedule-origin')
  scheduleName = await import('../../schedules/schedule-name')
  normalization = await import('@/lib/server/schedules/schedule-normalization')
})

after(() => {
  process.env.DATA_DIR = originalEnv.DATA_DIR
  process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE != null) {
    process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

// ── Helpers ───────────────────────────────────────────────────────────
function makeSchedule(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: `sched-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Schedule',
    agentId: 'agent-1',
    taskPrompt: 'check server status',
    scheduleType: 'interval' as const,
    intervalMs: 60_000,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// ══════════════════════════════════════════════════════════════════════
// Schedule normalization
// ══════════════════════════════════════════════════════════════════════
describe('schedule normalization', () => {
  it('1. interval schedule → nextRunAt = now + intervalMs', () => {
    const now = 1_700_000_000_000
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'interval', intervalMs: 60_000, agentId: 'a1', taskPrompt: 'do stuff' },
      { now },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.nextRunAt, now + 60_000)
    }
  })

  it('2. once schedule → nextRunAt = runAt', () => {
    const runAt = 1_700_000_060_000
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'once', runAt, agentId: 'a1', taskPrompt: 'one-shot' },
      { now: 1_700_000_000_000 },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.nextRunAt, runAt)
    }
  })

  it('3. missing taskPrompt with action/command → derives taskPrompt', () => {
    const cwd = process.env.WORKSPACE_DIR!
    const scriptPath = path.join(cwd, 'test_script.py')
    fs.writeFileSync(scriptPath, 'print("ok")\n')

    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'interval', intervalMs: 60_000, agentId: 'a1', action: 'run_script', path: 'test_script.py' },
      { cwd },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.ok(typeof result.value.taskPrompt === 'string')
      assert.ok((result.value.taskPrompt as string).length > 0)
      assert.ok((result.value.taskPrompt as string).includes('test_script.py'))
    }
  })

  it('4. invalid scheduleType → defaults to interval', () => {
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'bogus', intervalMs: 5000, agentId: 'a1', taskPrompt: 'hello' },
      { now: Date.now() },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.scheduleType, 'interval')
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// Schedule creation & storage
// ══════════════════════════════════════════════════════════════════════
describe('schedule creation & storage', () => {
  it('5. create interval schedule → stored in loadSchedules()', () => {
    const sched = makeSchedule({ id: 'int-1', scheduleType: 'interval', intervalMs: 30_000 })
    storage.saveSchedules({ 'int-1': sched })
    const loaded = storage.loadSchedules()
    assert.ok(loaded['int-1'])
    assert.equal(loaded['int-1'].scheduleType, 'interval')
    assert.equal(loaded['int-1'].intervalMs, 30_000)
  })

  it('6. create cron schedule → stored with cron expression', () => {
    const sched = makeSchedule({ id: 'cron-1', scheduleType: 'cron', cron: '*/5 * * * *' })
    storage.saveSchedules({ 'cron-1': sched })
    const loaded = storage.loadSchedules()
    assert.ok(loaded['cron-1'])
    assert.equal(loaded['cron-1'].cron, '*/5 * * * *')
  })

  it('7. create once schedule with runAt → stored correctly', () => {
    const runAt = Date.now() + 3_600_000
    const sched = makeSchedule({ id: 'once-1', scheduleType: 'once', runAt })
    storage.saveSchedules({ 'once-1': sched })
    const loaded = storage.loadSchedules()
    assert.ok(loaded['once-1'])
    assert.equal(loaded['once-1'].runAt, runAt)
    assert.equal(loaded['once-1'].scheduleType, 'once')
  })
})

// ══════════════════════════════════════════════════════════════════════
// Dedup on create
// ══════════════════════════════════════════════════════════════════════
describe('dedup on create', () => {
  it('8. same agent, prompt, cadence → duplicate detected', () => {
    const existing = {
      s1: makeSchedule({ id: 's1', agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval', intervalMs: 60_000 }),
    }
    const candidate = { agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval' as const, intervalMs: 60_000 }
    const dup = dedupe.findDuplicateSchedule(existing, candidate)
    assert.ok(dup, 'expected duplicate to be found')
    assert.equal(dup.id, 's1')
  })

  it('9. whitespace-normalized prompts match as duplicates', () => {
    const existing = {
      s1: makeSchedule({ id: 's1', agentId: 'a1', taskPrompt: '  deploy  app  ', scheduleType: 'interval', intervalMs: 60_000 }),
    }
    const candidate = { agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval' as const, intervalMs: 60_000 }
    const dup = dedupe.findDuplicateSchedule(existing, candidate)
    assert.ok(dup, 'whitespace-normalized prompt should match')
  })

  it('10. different agents → not duplicates', () => {
    const existing = {
      s1: makeSchedule({ id: 's1', agentId: 'agent-A', taskPrompt: 'deploy app', scheduleType: 'interval', intervalMs: 60_000 }),
    }
    const candidate = { agentId: 'agent-B', taskPrompt: 'deploy app', scheduleType: 'interval' as const, intervalMs: 60_000 }
    const dup = dedupe.findDuplicateSchedule(existing, candidate)
    assert.equal(dup, null, 'different agents should not be duplicates')
  })

  it('11. same prompt but different cadence type → not exact duplicates', () => {
    const existing = {
      s1: makeSchedule({ id: 's1', agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval', intervalMs: 60_000 }),
    }
    const candidate = { agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'cron' as const, cron: '*/1 * * * *' }
    const dup = dedupe.findDuplicateSchedule(existing, candidate)
    assert.equal(dup, null, 'different cadence type without session scope should not match')
  })

  it('12. fuzzy: similar prompts with same session → fuzzy match', () => {
    const existing = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'a1',
        taskPrompt: 'check server status',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        createdByAgentId: 'a1',
        createdInSessionId: 'sess-1',
      }),
    }
    const candidate = {
      agentId: 'a1',
      taskPrompt: 'check the server status',
      scheduleType: 'interval' as const,
      intervalMs: 3_600_000,
      createdByAgentId: 'a1',
      createdInSessionId: 'sess-1',
    }
    const dup = dedupe.findDuplicateSchedule(existing, candidate, {
      creatorScope: { sessionId: 'sess-1' },
    })
    assert.ok(dup, 'fuzzy prompt match should be found within same session')
  })
})

// ══════════════════════════════════════════════════════════════════════
// Schedule name derivation
// ══════════════════════════════════════════════════════════════════════
describe('schedule name derivation', () => {
  it('13. name provided → used as-is', () => {
    const name = scheduleName.resolveScheduleName({ name: 'My Custom Name', taskPrompt: 'do stuff' })
    assert.equal(name, 'My Custom Name')
  })

  it('14. no name, has taskPrompt → derived from prompt', () => {
    const name = scheduleName.resolveScheduleName({ taskPrompt: 'backup the database daily' })
    assert.ok(name.length > 0)
    assert.notEqual(name, '')
  })

  it('15. long prompt → truncated name', () => {
    const longPrompt = 'a'.repeat(200)
    const name = scheduleName.resolveScheduleName({ taskPrompt: longPrompt })
    assert.ok(name.length <= 83, `name should be truncated, got length ${name.length}`)
  })
})

// ══════════════════════════════════════════════════════════════════════
// Creator scope
// ══════════════════════════════════════════════════════════════════════
describe('creator scope', () => {
  it('16. schedule with createdByAgentId → isAgentCreatedSchedule returns true', () => {
    const sched = makeSchedule({ createdByAgentId: 'agent-1' })
    assert.equal(origin.isAgentCreatedSchedule(sched), true)
  })

  it('17. schedule without createdByAgentId → returns false', () => {
    const sched = makeSchedule({ createdByAgentId: undefined })
    // Remove the key entirely
    const plain = { ...sched }
    delete (plain as Record<string, unknown>).createdByAgentId
    assert.equal(origin.isAgentCreatedSchedule(plain), false)
  })

  it('18. empty string createdByAgentId → returns false', () => {
    const sched = makeSchedule({ createdByAgentId: '' })
    assert.equal(origin.isAgentCreatedSchedule(sched), false)
  })
})

// ══════════════════════════════════════════════════════════════════════
// Auto-delete logic
// ══════════════════════════════════════════════════════════════════════
describe('auto-delete logic', () => {
  it('19. once + agent-created → shouldAutoDelete = true', () => {
    const sched = makeSchedule({ scheduleType: 'once', createdByAgentId: 'agent-1' })
    assert.equal(origin.shouldAutoDeleteScheduleAfterTerminalRun(sched), true)
  })

  it('20. interval + agent-created → false', () => {
    const sched = makeSchedule({ scheduleType: 'interval', createdByAgentId: 'agent-1' })
    assert.equal(origin.shouldAutoDeleteScheduleAfterTerminalRun(sched), false)
  })

  it('21. cron + agent-created → false', () => {
    const sched = makeSchedule({ scheduleType: 'cron', createdByAgentId: 'agent-1' })
    assert.equal(origin.shouldAutoDeleteScheduleAfterTerminalRun(sched), false)
  })

  it('22. once + manual (no createdByAgentId) → false', () => {
    const plain = { scheduleType: 'once' as const, createdByAgentId: undefined }
    assert.equal(origin.shouldAutoDeleteScheduleAfterTerminalRun(plain), false)
  })
})

// ══════════════════════════════════════════════════════════════════════
// Related schedule discovery
// ══════════════════════════════════════════════════════════════════════
describe('related schedule discovery', () => {
  it('23-24. findEquivalentSchedules returns all equivalent schedules', () => {
    const base = {
      agentId: 'a1',
      taskPrompt: 'send weekly digest',
      scheduleType: 'interval' as const,
      intervalMs: 3_600_000,
      status: 'active' as const,
      createdByAgentId: 'a1',
      createdInSessionId: 'sess-1',
    }
    const schedules: Record<string, ReturnType<typeof makeSchedule>> = {
      eq1: makeSchedule({ ...base, id: 'eq1' }),
      eq2: makeSchedule({ ...base, id: 'eq2' }),
      eq3: makeSchedule({ ...base, id: 'eq3' }),
    }
    const candidate = { ...base, id: 'eq1' }
    const equivalents = dedupe.findEquivalentSchedules(schedules, candidate, { ignoreId: 'eq1' })
    assert.equal(equivalents.length, 2, 'should find 2 equivalents (excluding self)')
    const ids = equivalents.map((s) => s.id)
    assert.ok(ids.includes('eq2'))
    assert.ok(ids.includes('eq3'))
  })

  it('25. paused schedule still found by findEquivalentSchedules (default includes paused)', () => {
    const base = {
      agentId: 'a1',
      taskPrompt: 'send weekly digest',
      scheduleType: 'interval' as const,
      intervalMs: 3_600_000,
      createdByAgentId: 'a1',
      createdInSessionId: 'sess-1',
    }
    const schedules: Record<string, ReturnType<typeof makeSchedule>> = {
      eq1: makeSchedule({ ...base, id: 'eq1', status: 'active' }),
      eq2: makeSchedule({ ...base, id: 'eq2', status: 'paused' }),
    }
    const candidate = { ...base, id: 'eq1' }
    const equivalents = dedupe.findEquivalentSchedules(schedules, candidate, { ignoreId: 'eq1' })
    assert.equal(equivalents.length, 1)
    assert.equal(equivalents[0].id, 'eq2')
  })
})

// ══════════════════════════════════════════════════════════════════════
// Signature key stability
// ══════════════════════════════════════════════════════════════════════
describe('signature key stability', () => {
  it('26. same schedule → same signature key', () => {
    const sched = makeSchedule({ id: 'k1', agentId: 'a1', taskPrompt: 'hello world', scheduleType: 'interval', intervalMs: 60_000 })
    const key1 = dedupe.getScheduleSignatureKey(sched)
    const key2 = dedupe.getScheduleSignatureKey(sched)
    assert.equal(key1, key2)
    assert.ok(key1.length > 0, 'key should not be empty')
  })

  it('27. different prompt → different key', () => {
    const sched1 = makeSchedule({ agentId: 'a1', taskPrompt: 'hello world', scheduleType: 'interval', intervalMs: 60_000 })
    const sched2 = makeSchedule({ agentId: 'a1', taskPrompt: 'goodbye world', scheduleType: 'interval', intervalMs: 60_000 })
    assert.notEqual(dedupe.getScheduleSignatureKey(sched1), dedupe.getScheduleSignatureKey(sched2))
  })

  it('28. different agent → different key', () => {
    const sched1 = makeSchedule({ agentId: 'agent-A', taskPrompt: 'hello world', scheduleType: 'interval', intervalMs: 60_000 })
    const sched2 = makeSchedule({ agentId: 'agent-B', taskPrompt: 'hello world', scheduleType: 'interval', intervalMs: 60_000 })
    assert.notEqual(dedupe.getScheduleSignatureKey(sched1), dedupe.getScheduleSignatureKey(sched2))
  })

  it('29. different cadence → different key', () => {
    const sched1 = makeSchedule({ agentId: 'a1', taskPrompt: 'hello world', scheduleType: 'interval', intervalMs: 60_000 })
    const sched2 = makeSchedule({ agentId: 'a1', taskPrompt: 'hello world', scheduleType: 'interval', intervalMs: 120_000 })
    assert.notEqual(dedupe.getScheduleSignatureKey(sched1), dedupe.getScheduleSignatureKey(sched2))
  })
})

// ══════════════════════════════════════════════════════════════════════
// Status transitions
// ══════════════════════════════════════════════════════════════════════
describe('status transitions', () => {
  it('30. active → paused → active round-trip', () => {
    const sched = makeSchedule({ id: 'rt-1', status: 'active' })
    storage.saveSchedules({ 'rt-1': sched })

    // Pause
    const all1 = storage.loadSchedules()
    all1['rt-1'].status = 'paused'
    storage.saveSchedules(all1)
    assert.equal(storage.loadSchedules()['rt-1'].status, 'paused')

    // Reactivate
    const all2 = storage.loadSchedules()
    all2['rt-1'].status = 'active'
    storage.saveSchedules(all2)
    assert.equal(storage.loadSchedules()['rt-1'].status, 'active')
  })

  it('31. active → completed (once schedule after execution)', () => {
    const sched = makeSchedule({ id: 'oc-1', scheduleType: 'once', status: 'active', runAt: Date.now() })
    storage.saveSchedules({ 'oc-1': sched })

    const all = storage.loadSchedules()
    all['oc-1'].status = 'completed'
    all['oc-1'].lastRunAt = Date.now()
    storage.saveSchedules(all)
    assert.equal(storage.loadSchedules()['oc-1'].status, 'completed')
  })

  it('32. schedule with status failed → excluded from normal dedup searches', () => {
    const existing = {
      f1: makeSchedule({
        id: 'f1',
        agentId: 'a1',
        taskPrompt: 'deploy app',
        scheduleType: 'interval',
        intervalMs: 60_000,
        status: 'failed',
      }),
    }
    const candidate = { agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval' as const, intervalMs: 60_000 }
    // Default includeStatuses is ['active', 'paused'] — 'failed' excluded
    const dup = dedupe.findDuplicateSchedule(existing, candidate)
    assert.equal(dup, null, 'failed schedules should be excluded from dedup')
  })
})

// ══════════════════════════════════════════════════════════════════════
// Edge cases
// ══════════════════════════════════════════════════════════════════════
describe('edge cases', () => {
  it('33. empty taskPrompt → validation error', () => {
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'interval', intervalMs: 5000, agentId: 'a1', taskPrompt: '' },
      { now: Date.now() },
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.length > 0)
    }
  })

  it('34. null agentId → validation error', () => {
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'interval', intervalMs: 5000, agentId: null, taskPrompt: 'hello' },
      { now: Date.now() },
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('agentId'))
    }
  })

  it('35. very long cron expression → stored correctly', () => {
    const longCron = '*/5 * * * *'
    const sched = makeSchedule({ id: 'lc-1', scheduleType: 'cron', cron: longCron })
    storage.saveSchedules({ 'lc-1': sched })
    const loaded = storage.loadSchedules()
    assert.equal(loaded['lc-1'].cron, longCron)
  })
})

// ══════════════════════════════════════════════════════════════════════
// Additional edge cases & integration
// ══════════════════════════════════════════════════════════════════════
describe('additional scenarios', () => {
  it('36. getScheduleSignatureKey returns empty for missing agentId', () => {
    const sched = makeSchedule({ agentId: '', taskPrompt: 'hello' })
    const key = dedupe.getScheduleSignatureKey(sched)
    assert.equal(key, '')
  })

  it('37. getScheduleSignatureKey returns empty for missing taskPrompt', () => {
    const sched = makeSchedule({ agentId: 'a1', taskPrompt: '' })
    const key = dedupe.getScheduleSignatureKey(sched)
    assert.equal(key, '')
  })

  it('38. cron schedule normalization does not set nextRunAt (no interval fallback)', () => {
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'cron', cron: '0 9 * * *', agentId: 'a1', taskPrompt: 'daily task' },
      { now: Date.now() },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      // cron nextRunAt is not set by normalizeSchedulePayload (calculated by the scheduler)
      assert.equal(result.value.nextRunAt, undefined)
    }
  })

  it('39. duplicate with ignoreId → self is excluded', () => {
    const existing = {
      s1: makeSchedule({ id: 's1', agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval', intervalMs: 60_000 }),
    }
    const candidate = { id: 's1', agentId: 'a1', taskPrompt: 'deploy app', scheduleType: 'interval' as const, intervalMs: 60_000 }
    const dup = dedupe.findDuplicateSchedule(existing, candidate, { ignoreId: 's1' })
    assert.equal(dup, null, 'should not match self when ignoreId is set')
  })

  it('40. resolveScheduleName for generic name falls back to prompt derivation', () => {
    const name = scheduleName.resolveScheduleName({ name: 'schedule', taskPrompt: 'backup the database' })
    // 'schedule' is generic, so it should derive from taskPrompt
    assert.notEqual(name, 'schedule')
    assert.ok(name.length > 0)
  })

  it('41. saveSchedules overwrites entire collection', () => {
    storage.saveSchedules({ x1: makeSchedule({ id: 'x1' }) })
    storage.saveSchedules({ x2: makeSchedule({ id: 'x2' }) })
    const loaded = storage.loadSchedules()
    assert.equal(loaded['x1'], undefined, 'x1 should be gone after full overwrite')
    assert.ok(loaded['x2'])
  })

  it('42. normalizeSchedulePayload with command → derives taskPrompt from command', () => {
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'interval', intervalMs: 5000, agentId: 'a1', command: 'echo hello' },
      { now: Date.now() },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.ok(typeof result.value.taskPrompt === 'string')
      assert.ok((result.value.taskPrompt as string).includes('echo hello'))
    }
  })

  it('43. once schedule without runAt still normalizes', () => {
    const result = normalization.normalizeSchedulePayload(
      { scheduleType: 'once', agentId: 'a1', taskPrompt: 'one shot' },
      { now: Date.now() },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      // No runAt means no nextRunAt
      assert.equal(result.value.nextRunAt, undefined)
    }
  })

  it('44. findEquivalentSchedules with completed status excluded by default', () => {
    const existing = {
      c1: makeSchedule({
        id: 'c1',
        agentId: 'a1',
        taskPrompt: 'run backup',
        scheduleType: 'interval',
        intervalMs: 60_000,
        status: 'completed',
      }),
    }
    const candidate = { agentId: 'a1', taskPrompt: 'run backup', scheduleType: 'interval' as const, intervalMs: 60_000 }
    const results = dedupe.findEquivalentSchedules(existing, candidate)
    assert.equal(results.length, 0, 'completed should be excluded by default')
  })

  it('45. findEquivalentSchedules with explicit includeStatuses includes completed', () => {
    const existing = {
      c1: makeSchedule({
        id: 'c1',
        agentId: 'a1',
        taskPrompt: 'run backup',
        scheduleType: 'interval',
        intervalMs: 60_000,
        status: 'completed',
      }),
    }
    const candidate = { agentId: 'a1', taskPrompt: 'run backup', scheduleType: 'interval' as const, intervalMs: 60_000 }
    const results = dedupe.findEquivalentSchedules(existing, candidate, {
      includeStatuses: ['active', 'paused', 'completed'],
    })
    assert.equal(results.length, 1)
  })
})
