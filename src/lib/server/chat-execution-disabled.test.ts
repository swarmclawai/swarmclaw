import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chat-disabled-'))
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

test('executeSessionChatTurn persists a visible error for disabled agents', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const threadMod = await import('./src/lib/server/agent-thread-session')
    const ensureAgentThreadSession = threadMod.ensureAgentThreadSession
      || threadMod.default?.ensureAgentThreadSession
      || threadMod['module.exports']?.ensureAgentThreadSession
    const execMod = await import('./src/lib/server/chat-execution')
    const executeSessionChatTurn = execMod.executeSessionChatTurn
      || execMod.default?.executeSessionChatTurn
      || execMod['module.exports']?.executeSessionChatTurn

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
        disabled: false,
        createdAt: now,
        updatedAt: now,
        plugins: ['memory'],
      },
    })

    const session = ensureAgentThreadSession('molly')
    const agents = storage.loadAgents()
    agents.molly.disabled = true
    storage.saveAgents(agents)

    const result = await executeSessionChatTurn({
      sessionId: session.id,
      message: 'hello',
      runId: 'run-disabled-smoke',
    })
    const persisted = storage.loadSessions()[session.id]
    const lastMessage = persisted.messages[persisted.messages.length - 1]

    console.log(JSON.stringify({
      error: result.error || null,
      text: result.text || null,
      persisted: result.persisted || false,
      lastRole: lastMessage?.role || null,
      lastText: lastMessage?.text || null,
    }))
  `)

  assert.equal(output.persisted, true)
  assert.equal(output.lastRole, 'assistant')
  assert.match(String(output.error || ''), /disabled/i)
  assert.match(String(output.text || ''), /disabled/i)
  assert.match(String(output.lastText || ''), /disabled/i)
})
