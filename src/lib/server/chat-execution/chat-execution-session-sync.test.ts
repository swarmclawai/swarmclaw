import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chat-session-sync-'))
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

test('executeSessionChatTurn syncs updated agent runtime fields onto its thread session', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('@/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const providersMod = await import('@/lib/providers/index')
    const threadMod = await import('@/lib/server/agents/agent-thread-session')
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
    const ensureAgentThreadSession = threadMod.ensureAgentThreadSession
      || threadMod.default?.ensureAgentThreadSession
      || threadMod['module.exports']?.ensureAgentThreadSession
    const executeSessionChatTurn = execMod.executeSessionChatTurn
      || execMod.default?.executeSessionChatTurn
      || execMod['module.exports']?.executeSessionChatTurn
    const providers = providersMod.PROVIDERS
      || providersMod.default?.PROVIDERS
      || providersMod['module.exports']?.PROVIDERS

    providers['test-provider'] = {
      id: 'test-provider',
      name: 'Test Provider',
      models: ['unit'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: {
        async streamChat() {
          return 'synced'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      molly: {
        id: 'molly',
        name: 'Molly',
        description: 'Thread session sync test',
        provider: 'openai',
        model: 'old-model',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        heartbeatEnabled: false,
        heartbeatIntervalSec: null,
        plugins: ['memory'],
        createdAt: now,
        updatedAt: now,
      },
    })

    const session = ensureAgentThreadSession('molly')
    const agents = storage.loadAgents()
    agents.molly.provider = 'test-provider'
    agents.molly.model = 'unit'
    agents.molly.plugins = []
    agents.molly.heartbeatEnabled = true
    agents.molly.heartbeatIntervalSec = 90
    agents.molly.updatedAt = now + 1
    storage.saveAgents(agents)

    const result = await executeSessionChatTurn({
      sessionId: session.id,
      message: 'hello',
      runId: 'run-session-sync',
    })

    const persisted = storage.loadSession(session.id)
    console.log(JSON.stringify({
      text: result.text || null,
      provider: persisted?.provider || null,
      model: persisted?.model || null,
      plugins: persisted?.plugins || [],
      heartbeatEnabled: persisted?.heartbeatEnabled ?? null,
      heartbeatIntervalSec: persisted?.heartbeatIntervalSec ?? null,
    }))
  `)

  assert.equal(output.text, 'synced')
  assert.equal(output.provider, 'test-provider')
  assert.equal(output.model, 'unit')
  assert.deepEqual(output.plugins, [])
  assert.equal(output.heartbeatEnabled, true)
  assert.equal(output.heartbeatIntervalSec, 90)
})
