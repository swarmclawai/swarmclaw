import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('chat clear + undo round-trip restores messages and CLI session IDs', () => {
  const output = runWithTempDataDir<{
    clearStatus: number
    clearPayload: { cleared: number; undoToken: string }
    postClearCount: number
    postClearClaudeSessionId: string | null
    postClearOpencodeWebSessionId: string | null
    undoStatus: number
    undoPayload: { restored: number }
    postUndoCount: number
    postUndoClaudeSessionId: string | null
    postUndoOpencodeWebSessionId: string | null
    undoTwiceStatus: number
    undoTwicePayload: { error?: string }
    missingSessionStatus: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const clearRouteMod = await import('./src/app/api/chats/[id]/clear/route')
    const undoRouteMod = await import('./src/app/api/chats/[id]/clear/undo/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const clearRoute = clearRouteMod.default || clearRouteMod
    const undoRoute = undoRouteMod.default || undoRouteMod

    const now = Date.now()
    storage.saveSessions({
      sess_clear_1: {
        id: 'sess_clear_1',
        name: 'Clear test',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: 'cs_preserved_abc',
        codexThreadId: null,
        opencodeWebSessionId: 'owb_preserved_xyz',
        messages: [],
        createdAt: now,
        lastActiveAt: now,
      },
    })

    repo.appendMessage('sess_clear_1', { role: 'user', text: 'first', time: now })
    repo.appendMessage('sess_clear_1', { role: 'assistant', text: 'reply', time: now + 1 })
    repo.appendMessage('sess_clear_1', { role: 'user', text: 'second', time: now + 2 })

    const clearResponse = await clearRoute.POST(
      new Request('http://local/api/chats/sess_clear_1/clear', { method: 'POST' }),
      { params: Promise.resolve({ id: 'sess_clear_1' }) },
    )
    const clearPayload = await clearResponse.json()

    const postClearCount = repo.getMessages('sess_clear_1').length
    const postClearSession = storage.loadSession('sess_clear_1')

    const undoResponse = await undoRoute.POST(
      new Request('http://local/api/chats/sess_clear_1/clear/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ undoToken: clearPayload.undoToken }),
      }),
      { params: Promise.resolve({ id: 'sess_clear_1' }) },
    )
    const undoPayload = await undoResponse.json()

    const postUndoCount = repo.getMessages('sess_clear_1').length
    const postUndoSession = storage.loadSession('sess_clear_1')

    const undoTwiceResponse = await undoRoute.POST(
      new Request('http://local/api/chats/sess_clear_1/clear/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ undoToken: clearPayload.undoToken }),
      }),
      { params: Promise.resolve({ id: 'sess_clear_1' }) },
    )
    const undoTwicePayload = await undoTwiceResponse.json()

    const missingResponse = await clearRoute.POST(
      new Request('http://local/api/chats/not_a_real_session/clear', { method: 'POST' }),
      { params: Promise.resolve({ id: 'not_a_real_session' }) },
    )

    console.log(JSON.stringify({
      clearStatus: clearResponse.status,
      clearPayload: { cleared: clearPayload.cleared, undoToken: clearPayload.undoToken },
      postClearCount,
      postClearClaudeSessionId: postClearSession?.claudeSessionId ?? null,
      postClearOpencodeWebSessionId: postClearSession?.opencodeWebSessionId ?? null,
      undoStatus: undoResponse.status,
      undoPayload,
      postUndoCount,
      postUndoClaudeSessionId: postUndoSession?.claudeSessionId ?? null,
      postUndoOpencodeWebSessionId: postUndoSession?.opencodeWebSessionId ?? null,
      undoTwiceStatus: undoTwiceResponse.status,
      undoTwicePayload,
      missingSessionStatus: missingResponse.status,
    }))
  `, { prefix: 'swarmclaw-clear-undo-route-' })

  assert.equal(output.clearStatus, 200)
  assert.equal(output.clearPayload.cleared, 3)
  assert.match(output.clearPayload.undoToken, /^undo_/)
  assert.equal(output.postClearCount, 0)
  assert.equal(output.postClearClaudeSessionId, null, 'CLI session should be nulled after clear')
  assert.equal(output.postClearOpencodeWebSessionId, null, 'opencode-web session should be nulled after clear')
  assert.equal(output.undoStatus, 200)
  assert.equal(output.undoPayload.restored, 3)
  assert.equal(output.postUndoCount, 3)
  assert.equal(output.postUndoClaudeSessionId, 'cs_preserved_abc', 'CLI session ID should be restored by undo')
  assert.equal(output.postUndoOpencodeWebSessionId, 'owb_preserved_xyz', 'opencode-web session ID should be restored by undo')
  assert.equal(output.undoTwiceStatus, 404, 'undo token should be single-use')
  assert.ok(output.undoTwicePayload.error)
  assert.equal(output.missingSessionStatus, 404)
})
