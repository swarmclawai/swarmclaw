import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-runtime-settings-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('runtime settings defaults', () => {
  it('backfills explicit runtime defaults for clean installs', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const runtimeMod = await import('./src/lib/server/runtime-settings')
      const storage = storageMod.default || storageMod
      const runtime = runtimeMod.default || runtimeMod
      console.log(JSON.stringify({
        settings: storage.loadSettings(),
        runtime: runtime.loadRuntimeSettings(),
      }))
    `)

    assert.equal(output.settings.loopMode, 'bounded')
    assert.equal(output.settings.agentLoopRecursionLimit, 120)
    assert.equal(output.settings.orchestratorLoopRecursionLimit, 80)
    assert.equal(output.settings.legacyOrchestratorMaxTurns, 16)
    assert.equal(output.settings.ongoingLoopMaxIterations, 250)
    assert.equal(output.settings.ongoingLoopMaxRuntimeMinutes, 60)
    assert.equal(output.settings.delegationMaxDepth, 3)
    assert.equal(output.settings.shellCommandTimeoutSec, 30)
    assert.equal(output.settings.claudeCodeTimeoutSec, 1800)
    assert.equal(output.settings.cliProcessTimeoutSec, 1800)
    assert.equal(output.settings.heartbeatIntervalSec, 1800)
    assert.equal(output.settings.heartbeatAckMaxChars, 300)
    assert.equal(output.settings.heartbeatShowOk, false)
    assert.equal(output.settings.heartbeatShowAlerts, true)
    assert.equal(output.settings.heartbeatTarget, null)
    assert.equal(output.settings.heartbeatPrompt, null)
    assert.equal(output.runtime.agentLoopRecursionLimit, 120)
    assert.equal(output.runtime.orchestratorLoopRecursionLimit, 80)
    assert.equal(output.runtime.legacyOrchestratorMaxTurns, 16)
  })

  it('clamps invalid persisted runtime settings into the supported range', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const runtimeMod = await import('./src/lib/server/runtime-settings')
      const storage = storageMod.default || storageMod
      const runtime = runtimeMod.default || runtimeMod

      storage.saveSettings({
        loopMode: 'invalid',
        agentLoopRecursionLimit: 999,
        orchestratorLoopRecursionLimit: -5,
        legacyOrchestratorMaxTurns: 0,
        ongoingLoopMaxIterations: 999999,
        ongoingLoopMaxRuntimeMinutes: -1,
        delegationMaxDepth: 99,
        shellCommandTimeoutSec: 0,
        claudeCodeTimeoutSec: 999999,
        cliProcessTimeoutSec: 'abc',
        heartbeatIntervalSec: 999999,
        heartbeatAckMaxChars: -50,
        heartbeatShowOk: 'yes',
        heartbeatShowAlerts: 'off',
        heartbeatTarget: '   ',
        heartbeatPrompt: '   ',
      })

      console.log(JSON.stringify({
        settings: storage.loadSettings(),
        runtime: runtime.loadRuntimeSettings(),
      }))
    `)

    assert.equal(output.settings.loopMode, 'bounded')
    assert.equal(output.settings.agentLoopRecursionLimit, 200)
    assert.equal(output.settings.orchestratorLoopRecursionLimit, 1)
    assert.equal(output.settings.legacyOrchestratorMaxTurns, 1)
    assert.equal(output.settings.ongoingLoopMaxIterations, 5000)
    assert.equal(output.settings.ongoingLoopMaxRuntimeMinutes, 0)
    assert.equal(output.settings.delegationMaxDepth, 12)
    assert.equal(output.settings.shellCommandTimeoutSec, 1)
    assert.equal(output.settings.claudeCodeTimeoutSec, 7200)
    assert.equal(output.settings.cliProcessTimeoutSec, 1800)
    assert.equal(output.settings.heartbeatIntervalSec, 86400)
    assert.equal(output.settings.heartbeatAckMaxChars, 0)
    assert.equal(output.settings.heartbeatShowOk, true)
    assert.equal(output.settings.heartbeatShowAlerts, false)
    assert.equal(output.settings.heartbeatTarget, null)
    assert.equal(output.settings.heartbeatPrompt, null)
    assert.equal(output.runtime.ongoingLoopMaxRuntimeMs, null)
  })
})
