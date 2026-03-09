import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chat-eval-history-'))
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

test('executeSessionChatTurn persists internal eval user turns for same-thread recall', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const providersMod = await import('./src/lib/providers/index')
    const execMod = await import('./src/lib/server/chat-execution')
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
        async streamChat({ session, message, loadHistory }) {
          if (/what is project kodiak's code name\\??/i.test(message)) {
            const history = loadHistory(session.id)
            const remembered = history.find((entry) =>
              entry?.role === 'user' && typeof entry.text === 'string' && entry.text.includes('code name Sunbird')
            )
            return remembered ? 'Project Kodiak\\'s code name is Sunbird.' : 'I cannot find the code name in the thread history.'
          }
          return 'Stored.'
        },
      },
    }

    const now = Date.now()
    const sessions = storage.loadSessions()
    sessions['eval-history'] = {
      id: 'eval-history',
      name: 'Eval History',
      cwd: process.cwd(),
      user: 'eval-runner',
      provider: 'test-provider',
      model: 'unit',
      claudeSessionId: null,
      messages: [],
      createdAt: now,
      lastActiveAt: now,
      plugins: [],
    }
    storage.saveSessions(sessions)

    await executeSessionChatTurn({
      sessionId: 'eval-history',
      message: 'Remember that Project Kodiak uses the code name Sunbird.',
      internal: true,
      source: 'eval',
    })

    const recall = await executeSessionChatTurn({
      sessionId: 'eval-history',
      message: 'What is Project Kodiak\\'s code name?',
      internal: true,
      source: 'eval',
    })

    const storedSession = storage.loadSessions()['eval-history']
    console.log(JSON.stringify({
      recallText: recall.text,
      roles: storedSession.messages.map((entry) => entry.role),
      texts: storedSession.messages.map((entry) => entry.text),
    }))
  `)

  assert.match(String(output.recallText || ''), /Sunbird/)
  assert.deepEqual(output.roles, ['user', 'assistant', 'user', 'assistant'])
  assert.match(String(output.texts?.[0] || ''), /Project Kodiak uses the code name Sunbird/)
})
