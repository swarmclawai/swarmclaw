import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('chat route rejects malformed JSON with a 400 before queueing work', () => {
  const output = runWithTempDataDir<{
    status: number
    payload: { error?: string }
    runCount: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const routeMod = await import('./src/app/api/chats/[id]/chat/route')
    const runsMod = await import('@/lib/server/runtime/session-run-manager')
    const storage = storageMod.default || storageMod
    const route = routeMod.default || routeMod
    const runs = runsMod.default || runsMod

    const now = Date.now()
    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'Malformed Agent',
        provider: 'openai',
        model: 'gpt-4o-mini',
        extensions: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      sess_1: {
        id: 'sess_1',
        name: 'Malformed Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'workbench',
        provider: 'openai',
        model: 'gpt-4o-mini',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'agent_1',
        extensions: [],
      },
    })

    const response = await route.POST(
      new Request('http://local/api/chats/sess_1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad-json',
      }),
      { params: Promise.resolve({ id: 'sess_1' }) },
    )

    console.log(JSON.stringify({
      status: response.status,
      payload: await response.json(),
      runCount: runs.listRuns({ sessionId: 'sess_1' }).length,
    }))
  `, { prefix: 'swarmclaw-chat-route-invalid-json-' })

  assert.equal(output.status, 400)
  assert.equal(output.payload.error, 'Invalid or missing request body')
  assert.equal(output.runCount, 0)
})
