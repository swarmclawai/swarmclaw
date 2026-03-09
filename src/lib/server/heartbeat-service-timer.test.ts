import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-heartbeat-timer-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        BROWSER_PROFILES_DIR: path.join(tempDir, 'browser-profiles'),
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

describe('heartbeat-service scheduling', () => {
  it('does not fire periodic heartbeats for agents that are explicitly off', () => {
    const output = runWithTempDataDir(`
      const { setTimeout: delay } = await import('node:timers/promises')
      const storageMod = await import('./src/lib/server/storage')
      const heartbeatMod = await import('./src/lib/server/heartbeat-service')
      const runsMod = await import('./src/lib/server/session-run-manager')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const heartbeat = heartbeatMod.default || heartbeatMod['module.exports'] || heartbeatMod
      const runs = runsMod.default || runsMod['module.exports'] || runsMod

      const now = Date.now()
      storage.saveSettings({ loopMode: 'bounded' })
      storage.saveAgents({
        probe: {
          id: 'probe',
          name: 'Probe',
          description: 'Heartbeat probe',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          fallbackCredentialIds: [],
          heartbeatEnabled: false,
          heartbeatIntervalSec: 1,
          createdAt: now,
          updatedAt: now,
          plugins: [],
        },
      })
      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Probe Main',
          shortcutForAgentId: 'probe',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [{ role: 'user', text: 'Old task', time: now - 20_000 }],
          createdAt: now - 20_000,
          lastActiveAt: now - 20_000,
          sessionType: 'human',
          agentId: 'probe',
          heartbeatEnabled: false,
        },
      })

      heartbeat.startHeartbeatService()
      await delay(6_500)
      const later = runs.listRuns({ sessionId: 'main', limit: 20 })
      heartbeat.stopHeartbeatService()

      console.log(JSON.stringify({
        laterCount: later.length,
        laterSources: later.map((run) => run.source),
      }))
    `)

    assert.equal(output.laterCount, 0)
    assert.deepEqual(output.laterSources, [])
  })

  it('fires periodic heartbeats only after the service tick window when enabled', () => {
    const output = runWithTempDataDir(`
      const { setTimeout: delay } = await import('node:timers/promises')
      const storageMod = await import('./src/lib/server/storage')
      const heartbeatMod = await import('./src/lib/server/heartbeat-service')
      const runsMod = await import('./src/lib/server/session-run-manager')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const heartbeat = heartbeatMod.default || heartbeatMod['module.exports'] || heartbeatMod
      const runs = runsMod.default || runsMod['module.exports'] || runsMod

      const now = Date.now()
      storage.saveSettings({ loopMode: 'bounded' })
      storage.saveAgents({
        probe: {
          id: 'probe',
          name: 'Probe',
          description: 'Heartbeat probe',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          fallbackCredentialIds: [],
          heartbeatEnabled: true,
          heartbeatIntervalSec: 1,
          heartbeatInterval: '1s',
          heartbeatPrompt: 'Reply HEARTBEAT_OK if idle.',
          createdAt: now,
          updatedAt: now,
          plugins: [],
        },
      })
      storage.saveSessions({
        main: {
          id: 'main',
          name: 'Probe Main',
          shortcutForAgentId: 'probe',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [{ role: 'user', text: 'Old task', time: now - 20_000 }],
          createdAt: now - 20_000,
          lastActiveAt: now - 20_000,
          sessionType: 'human',
          agentId: 'probe',
          heartbeatEnabled: true,
          heartbeatIntervalSec: 1,
        },
      })

      const startedAt = Date.now()
      heartbeat.startHeartbeatService()
      await delay(2_500)
      const early = runs.listRuns({ sessionId: 'main', limit: 20 })
      await delay(4_500)
      const later = runs.listRuns({ sessionId: 'main', limit: 20 })
      heartbeat.stopHeartbeatService()

      console.log(JSON.stringify({
        earlyCount: early.length,
        laterCount: later.length,
        laterSources: later.map((run) => run.source),
        firstQueuedDeltaMs: later[0]?.queuedAt ? later[0].queuedAt - startedAt : null,
      }))
    `)

    assert.equal(output.earlyCount, 0, 'no periodic heartbeat before the 5s service tick')
    assert.ok(output.laterCount >= 1, 'expected at least one periodic heartbeat run after the tick window')
    assert.ok((output.laterSources || []).includes('heartbeat'))
    assert.equal(typeof output.firstQueuedDeltaMs, 'number')
    assert.ok(output.firstQueuedDeltaMs >= 4_500, `expected first heartbeat after timer window, got ${output.firstQueuedDeltaMs}`)
  })
})
