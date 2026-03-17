import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('chat messages route materializes stale streaming artifacts even if runtime memory is stale', () => {
  const output = runWithTempDataDir<{
    status: number
    returnedStreaming: boolean | null
    returnedText: string | null
    persistedStreaming: boolean | null
    persistedText: string | null
	  }>(`
	    const storageMod = await import('./src/lib/server/storage')
	    const routeMod = await import('./src/app/api/chats/[id]/messages/route')
	    const runtimeStateMod = await import('./src/lib/server/runtime/runtime-state')
	    const storage = storageMod.default || storageMod
	    const route = routeMod.default || routeMod
	    const runtimeState = runtimeStateMod.default || runtimeStateMod

    storage.upsertStoredItem('sessions', 'session-stale', {
      id: 'session-stale',
      name: 'Stale session',
      provider: 'ollama',
      model: 'test-model',
      createdAt: 1,
      updatedAt: 1,
      active: false,
      currentRunId: null,
      messages: [
        { role: 'user', text: 'hello', time: 1 },
        {
          role: 'assistant',
          text: 'partial reply',
          time: 2,
          streaming: true,
          toolEvents: [{ name: 'http_request', input: '{}', output: '{"ok":true}' }],
        },
      ],
    })

	    runtimeState.registerActiveSessionProcess('session-stale', { kill() {} })

    const response = await route.GET(
      new Request('http://local/api/chats/session-stale/messages'),
      { params: Promise.resolve({ id: 'session-stale' }) },
    )
    const payload = await response.json()
    const persisted = storage.loadSession('session-stale')
    const returned = Array.isArray(payload) ? payload[payload.length - 1] : null
    const saved = Array.isArray(persisted?.messages) ? persisted.messages[persisted.messages.length - 1] : null

    console.log(JSON.stringify({
      status: response.status,
      returnedStreaming: returned?.streaming === true,
      returnedText: returned?.text || null,
      persistedStreaming: saved?.streaming === true,
      persistedText: saved?.text || null,
    }))
  `, { prefix: 'swarmclaw-chat-messages-route-' })

  assert.equal(output.status, 200)
  assert.equal(output.returnedStreaming, false)
  assert.equal(output.persistedStreaming, false)
  assert.equal(output.returnedText, 'partial reply')
  assert.equal(output.persistedText, 'partial reply')
})
