import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('GET /api/chats/[id]/context-status returns token usage summary', () => {
  const output = runWithTempDataDir<{
    status: number
    hasContextWindow: boolean
    percentUsed: number
    messageCount: number
    strategy: string
    missingStatus: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/chats/[id]/context-status/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveSessions({
      sess_ctx_1: {
        id: 'sess_ctx_1',
        name: 'Context status test',
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

    repo.appendMessage('sess_ctx_1', { role: 'user', text: 'hello world', time: now })
    repo.appendMessage('sess_ctx_1', { role: 'assistant', text: 'hi there, how can I help?', time: now + 1 })

    const response = await route.GET(
      new Request('http://local/api/chats/sess_ctx_1/context-status'),
      { params: Promise.resolve({ id: 'sess_ctx_1' }) },
    )
    const payload = await response.json()

    const missingResponse = await route.GET(
      new Request('http://local/api/chats/missing/context-status'),
      { params: Promise.resolve({ id: 'missing' }) },
    )

    console.log(JSON.stringify({
      status: response.status,
      hasContextWindow: typeof payload.contextWindow === 'number' && payload.contextWindow > 0,
      percentUsed: payload.percentUsed,
      messageCount: payload.messageCount,
      strategy: payload.strategy,
      missingStatus: missingResponse.status,
    }))
  `, { prefix: 'swarmclaw-context-status-route-' })

  assert.equal(output.status, 200)
  assert.equal(output.hasContextWindow, true)
  assert.ok(output.percentUsed >= 0 && output.percentUsed <= 100)
  assert.equal(output.messageCount, 2)
  assert.ok(['ok', 'warning', 'critical'].includes(output.strategy))
  assert.equal(output.missingStatus, 404)
})

test('GET /api/chats/[id]/context-status uses OpenRouter model metadata context window', () => {
  const output = runWithTempDataDir<{
    status: number
    contextWindow: number
  }>(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cachePath = path.join(process.env.DATA_DIR, 'openrouter-model-context.json')
    fs.writeFileSync(cachePath, JSON.stringify({
      loadedAt: Date.now(),
      models: { 'minimax/minimax-m3': 524288 },
    }))

    globalThis.fetch = async () => {
      throw new Error('route should use seeded OpenRouter model metadata cache')
    }

    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/chats/[id]/context-status/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveSessions({
      sess_ctx_openrouter: {
        id: 'sess_ctx_openrouter',
        name: 'OpenRouter context status test',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openrouter',
        model: 'minimax/minimax-m3',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
      },
    })

    repo.appendMessage('sess_ctx_openrouter', { role: 'user', text: 'hello world', time: now })

    const response = await route.GET(
      new Request('http://local/api/chats/sess_ctx_openrouter/context-status'),
      { params: Promise.resolve({ id: 'sess_ctx_openrouter' }) },
    )
    const payload = await response.json()

    console.log(JSON.stringify({
      status: response.status,
      contextWindow: payload.contextWindow,
    }))
  `, { prefix: 'swarmclaw-context-status-route-' })

  assert.equal(output.status, 200)
  assert.equal(output.contextWindow, 524_288)
  assert.notEqual(output.contextWindow, 8_192)
})
