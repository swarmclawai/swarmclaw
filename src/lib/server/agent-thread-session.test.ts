import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-agent-thread-'))
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

describe('ensureAgentThreadSession', () => {
  it('creates and reuses an agent shortcut chat for heartbeat-enabled agents', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const helperMod = await import('./src/lib/server/agent-thread-session')
      const ensureAgentThreadSession = helperMod.ensureAgentThreadSession
        || helperMod.default?.ensureAgentThreadSession
        || helperMod['module.exports']?.ensureAgentThreadSession

      const now = Date.now()
      storage.saveAgents({
        molly: {
          id: 'molly',
          name: 'Molly',
          description: 'Autonomous helper',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          fallbackCredentialIds: [],
          heartbeatEnabled: true,
          heartbeatIntervalSec: 600,
          memoryScopeMode: 'agent',
          memoryTierPreference: 'blended',
          projectId: 'proj-1',
          createdAt: now,
          updatedAt: now,
          plugins: ['memory', 'web_search'],
        },
      })

      const first = ensureAgentThreadSession('molly')
      const second = ensureAgentThreadSession('molly')
      const agents = storage.loadAgents()
      const sessions = storage.loadSessions()

      console.log(JSON.stringify({
        firstId: first?.id,
        secondId: second?.id,
        threadSessionId: agents.molly?.threadSessionId || null,
        session: first ? sessions[first.id] : null,
      }))
    `)

    assert.equal(output.firstId, output.secondId)
    assert.equal(output.threadSessionId, output.firstId)
    assert.equal(output.session.shortcutForAgentId, 'molly')
    assert.equal(output.session.agentId, 'molly')
    assert.equal(output.session.heartbeatEnabled, true)
    assert.equal(output.session.memoryScopeMode, 'agent')
    assert.equal(output.session.memoryTierPreference, 'blended')
    assert.equal(output.session.projectId, 'proj-1')
    assert.deepEqual(output.session.plugins, ['memory', 'web_search'])
  })

  it('does not create a new shortcut chat when the agent is disabled', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const helperMod = await import('./src/lib/server/agent-thread-session')
      const ensureAgentThreadSession = helperMod.ensureAgentThreadSession
        || helperMod.default?.ensureAgentThreadSession
        || helperMod['module.exports']?.ensureAgentThreadSession

      const now = Date.now()
      storage.saveAgents({
        molly: {
          id: 'molly',
          name: 'Molly',
          description: 'Temporarily disabled helper',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          fallbackCredentialIds: [],
          disabled: true,
          heartbeatEnabled: true,
          heartbeatIntervalSec: 600,
          createdAt: now,
          updatedAt: now,
          plugins: ['memory'],
        },
      })

      const session = ensureAgentThreadSession('molly')
      const agents = storage.loadAgents()
      const sessions = storage.loadSessions()

      console.log(JSON.stringify({
        sessionId: session?.id || null,
        threadSessionId: agents.molly?.threadSessionId || null,
        sessionCount: Object.keys(sessions).length,
      }))
    `)

    assert.equal(output.sessionId, null)
    assert.equal(output.threadSessionId, null)
    assert.equal(output.sessionCount, 0)
  })

  it('propagates explicit OpenClaw gateway agent ids into the shortcut session', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const storage = storageMod.default || storageMod['module.exports'] || storageMod
      const helperMod = await import('./src/lib/server/agent-thread-session')
      const ensureAgentThreadSession = helperMod.ensureAgentThreadSession
        || helperMod.default?.ensureAgentThreadSession
        || helperMod['module.exports']?.ensureAgentThreadSession

      const now = Date.now()
      storage.saveAgents({
        oc: {
          id: 'oc',
          name: 'OpenClaw Ops',
          description: 'OpenClaw-backed helper',
          provider: 'openclaw',
          model: 'default',
          credentialId: null,
          apiEndpoint: null,
          gatewayProfileId: 'gateway-test',
          fallbackCredentialIds: [],
          openclawAgentId: 'main',
          heartbeatEnabled: true,
          heartbeatIntervalSec: 600,
          createdAt: now,
          updatedAt: now,
          plugins: [],
        },
      })

      const session = ensureAgentThreadSession('oc')
      const sessions = storage.loadSessions()

      console.log(JSON.stringify({
        session: session ? sessions[session.id] : null,
      }))
    `)

    assert.equal(output.session.openclawAgentId, 'main')
  })
})
