import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('POST /api/chats/[id]/compact returns no_action when transcript is smaller than keepLastN', () => {
  const output = runWithTempDataDir<{
    status: number
    payload: { status?: string; messageCount?: number; keepLastN?: number }
    missingStatus: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/chats/[id]/compact/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveSessions({
      sess_compact_1: {
        id: 'sess_compact_1',
        name: 'Compact test',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-4o-mini',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
      },
    })

    // Only 2 messages — smaller than default keepLastN (10), so compact should no-op.
    repo.appendMessage('sess_compact_1', { role: 'user', text: 'hi', time: now })
    repo.appendMessage('sess_compact_1', { role: 'assistant', text: 'hello', time: now + 1 })

    const response = await route.POST(
      new Request('http://local/api/chats/sess_compact_1/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 'sess_compact_1' }) },
    )
    const payload = await response.json()

    const missingResponse = await route.POST(
      new Request('http://local/api/chats/missing/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 'missing' }) },
    )

    console.log(JSON.stringify({
      status: response.status,
      payload,
      missingStatus: missingResponse.status,
    }))
  `, { prefix: 'swarmclaw-compact-route-' })

  assert.equal(output.status, 200)
  assert.equal(output.payload.status, 'no_action')
  assert.equal(output.payload.messageCount, 2)
  assert.equal(output.payload.keepLastN, 10)
  assert.equal(output.missingStatus, 404)
})
