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
let mod: typeof import('@/lib/server/schedules/schedule-normalization')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-schedule-norm-'))
  workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/schedules/schedule-normalization')
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

describe('extractScheduleCommandScriptPath', () => {
  it('extracts script path from python command', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('python3 scripts/run.py'), 'scripts/run.py')
  })

  it('extracts script path from node command', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('node ./build/index.js'), './build/index.js')
  })

  it('extracts script path from bash command', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('bash deploy.sh'), 'deploy.sh')
  })

  it('extracts script path from npx tsx command', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('npx tsx src/worker.ts'), 'src/worker.ts')
  })

  it('extracts script path from deno run command', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('deno run main.ts'), 'main.ts')
  })

  it('skips flags before finding path', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('python3 -u scripts/run.py'), 'scripts/run.py')
  })

  it('returns null for bare command with no script-like argument', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('echo hello'), null)
  })

  it('returns null for empty command', () => {
    assert.equal(mod.extractScheduleCommandScriptPath(''), null)
  })

  it('handles quoted paths', () => {
    assert.equal(mod.extractScheduleCommandScriptPath('python3 "my script.py"'), 'my script.py')
  })
})

describe('normalizeSchedulePayload', () => {
  it('rejects missing agentId', () => {
    const result = mod.normalizeSchedulePayload({ taskPrompt: 'do stuff' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /agentId/)
  })

  it('rejects missing taskPrompt/command/path', () => {
    const result = mod.normalizeSchedulePayload({ agentId: 'agent-1' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /taskPrompt/)
  })

  it('accepts valid payload with taskPrompt', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      taskPrompt: 'Run the daily report',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.agentId, 'agent-1')
      assert.equal(result.value.taskPrompt, 'Run the daily report')
    }
  })

  it('derives taskPrompt from command when not explicit', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      command: 'echo hello',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.match(result.value.taskPrompt as string, /echo hello/)
    }
  })

  it('normalizes scheduleType to interval by default', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      taskPrompt: 'test',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.scheduleType, 'interval')
  })

  it('preserves valid scheduleType values', () => {
    for (const t of ['cron', 'interval', 'once'] as const) {
      const result = mod.normalizeSchedulePayload({
        agentId: 'agent-1',
        taskPrompt: 'test',
        scheduleType: t,
      })
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.value.scheduleType, t)
    }
  })

  it('falls back invalid scheduleType to interval', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      taskPrompt: 'test',
      scheduleType: 'bogus',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.scheduleType, 'interval')
  })

  it('prefers a valid legacy type when scheduleType is stuck at interval', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      taskPrompt: 'test',
      scheduleType: 'interval',
      type: 'once',
      runAt: '2026-03-12T09:00:00.000Z',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.scheduleType, 'once')
      assert.equal('type' in result.value, false)
      assert.equal(typeof result.value.runAt, 'number')
    }
  })

  it('normalizes status to active for unknown values', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      taskPrompt: 'test',
      status: 'invalid-status',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.status, 'active')
  })

  it('preserves valid status values', () => {
    for (const s of ['active', 'paused', 'completed', 'failed', 'archived']) {
      const result = mod.normalizeSchedulePayload({
        agentId: 'agent-1',
        taskPrompt: 'test',
        status: s,
      })
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.value.status, s)
    }
  })

  it('calculates nextRunAt for interval type when intervalMs is set', () => {
    const now = 1_000_000
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', scheduleType: 'interval', intervalMs: 5000 },
      { now },
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.nextRunAt, 1_005_000)
  })

  it('uses runAt for once type', () => {
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', scheduleType: 'once', runAt: 9_999_999 },
      { now: 1_000_000 },
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.nextRunAt, 9_999_999)
  })

  it('parses ISO runAt timestamps for once schedules', () => {
    const result = mod.normalizeSchedulePayload(
      {
        agentId: 'agent-1',
        taskPrompt: 'test',
        scheduleType: 'once',
        runAt: '2026-03-12T09:00:00.000Z',
      },
      { now: 1_000_000 },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      const expected = Date.parse('2026-03-12T09:00:00.000Z')
      assert.equal(result.value.runAt, expected)
      assert.equal(result.value.nextRunAt, expected)
    }
  })

  it('does not overwrite existing nextRunAt', () => {
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', scheduleType: 'interval', intervalMs: 5000, nextRunAt: 42 },
      { now: 1_000_000 },
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.nextRunAt, 42)
  })

  it('trims whitespace from agentId', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: '  agent-1  ',
      taskPrompt: 'test',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.agentId, 'agent-1')
  })

  it('rejects run_script action without path', () => {
    const result = mod.normalizeSchedulePayload({
      agentId: 'agent-1',
      taskPrompt: 'test',
      action: 'run_script',
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /run_script/)
  })

  it('rejects path outside workspace', () => {
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', path: '/etc/passwd' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /must stay inside/)
  })

  it('validates path exists for file-based schedules', () => {
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', path: 'nonexistent.py' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /not found/)
  })

  it('accepts path that exists inside workspace', () => {
    const scriptPath = path.join(workspaceDir, 'test-script.py')
    fs.writeFileSync(scriptPath, '#!/usr/bin/env python3\nprint("ok")')
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', path: 'test-script.py' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, true)
  })

  it('derives taskPrompt from path with run_script action', () => {
    const scriptPath = path.join(workspaceDir, 'runner.sh')
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho ok')
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', action: 'run_script', path: 'runner.sh' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.match(result.value.taskPrompt as string, /Run the script/)
  })

  it('derives taskPrompt from path without specific action', () => {
    const filePath = path.join(workspaceDir, 'data.csv')
    fs.writeFileSync(filePath, 'a,b\n1,2')
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', path: 'data.csv' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.match(result.value.taskPrompt as string, /Use the file/)
  })

  it('rejects command referencing a missing script file', () => {
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', command: 'python3 missing_script.py' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /missing file/)
  })

  it('accepts command referencing an existing script file', () => {
    const scriptPath = path.join(workspaceDir, 'existing.py')
    fs.writeFileSync(scriptPath, 'print("ok")')
    const result = mod.normalizeSchedulePayload(
      { agentId: 'agent-1', taskPrompt: 'test', command: 'python3 existing.py' },
      { cwd: workspaceDir },
    )
    assert.equal(result.ok, true)
  })
})
