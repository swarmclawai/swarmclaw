import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chatroom-session-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
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

describe('chatroom synthetic session persistence', () => {
  it('reuses stored synthetic sessions and preserves delegate resume state', () => {
    const output = runWithTempDataDir(`
      const helpersMod = await import('./src/lib/server/chatroom-helpers')
      const helpers = helpersMod.default || helpersMod
      const storageMod = await import('./src/lib/server/storage')
      const storage = storageMod.default || storageMod
      const now = Date.now()
      const agent = {
        id: 'default',
        name: 'Molly',
        description: '',
        systemPrompt: '',
        provider: 'openai',
        model: 'gpt-4o',
        createdAt: now,
        updatedAt: now,
        plugins: ['delegate'],
      }

      const first = helpers.ensureSyntheticSession(agent, 'room-1')
      helpers.appendSyntheticSessionMessage(first.id, 'user', 'first prompt')

      const sessions = storage.loadSessions()
      sessions[first.id].delegateResumeIds = {
        claudeCode: null,
        codex: 'resume-123',
        opencode: null,
        gemini: null,
      }
      storage.saveSessions(sessions)

      const second = helpers.ensureSyntheticSession({ ...agent, model: 'gpt-4.1' }, 'room-1')
      console.log(JSON.stringify({
        sessionId: second.id,
        cwd: second.cwd,
        model: second.model,
        messageCount: second.messages.length,
        firstMessage: second.messages[0]?.text || '',
        delegateResumeIds: second.delegateResumeIds,
        plugins: second.plugins || [],
      }))
    `)

    assert.equal(output.sessionId, 'chatroom-room-1-default')
    assert.match(String(output.cwd), /chatrooms[\/\\]room-1$/)
    assert.equal(output.model, 'gpt-4.1')
    assert.equal(output.messageCount, 1)
    assert.equal(output.firstMessage, 'first prompt')
    assert.equal(output.delegateResumeIds?.codex, 'resume-123')
    assert.deepEqual(output.plugins, ['delegate'])
  })
})
