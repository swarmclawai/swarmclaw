import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('appendMessage notifies both generic and per-session message topics', () => {
  const output = runWithTempDataDir<{
    genericTopics: string[]
    sessionTopics: string[]
  }>(`
    const { WebSocket } = await import('ws')
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-notify': {
        id: 'sess-notify',
        name: 'Notify Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const genericPayloads = []
    const sessionPayloads = []
    globalThis.__swarmclaw_ws__ = {
      wss: null,
      clients: new Set([
        {
          ws: {
            readyState: WebSocket.OPEN,
            send(payload) { genericPayloads.push(JSON.parse(payload)) },
          },
          topics: new Set(['messages']),
        },
        {
          ws: {
            readyState: WebSocket.OPEN,
            send(payload) { sessionPayloads.push(JSON.parse(payload)) },
          },
          topics: new Set(['messages:sess-notify']),
        },
      ]),
    }

    repo.appendMessage('sess-notify', {
      role: 'user',
      text: 'hello',
      time: 1,
    })

    console.log(JSON.stringify({
      genericTopics: genericPayloads.map((payload) => payload.topic),
      sessionTopics: sessionPayloads.map((payload) => payload.topic),
    }))
  `, { prefix: 'swarmclaw-message-repo-notify-' })

  assert.deepEqual(output.genericTopics, ['messages'])
  assert.deepEqual(output.sessionTopics, ['messages:sess-notify'])
})

test('lazy migration compacts legacy session message blobs after table persistence', () => {
  const output = runWithTempDataDir<{
    returnedTexts: string[]
    secondReadTexts: string[]
    blobMessageCount: number
    messageCount: number
    lastMessageText: string | null
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    storage.saveSessions({
      'sess-legacy-blob': {
        id: 'sess-legacy-blob',
        name: 'Legacy blob session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [
          { role: 'user', text: 'first legacy prompt', time: 1 },
          { role: 'assistant', text: 'first legacy reply', time: 2 },
          { role: 'user', text: 'second legacy prompt', time: 3 },
        ],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const returned = repo.getMessages('sess-legacy-blob')
    const secondRead = repo.getMessages('sess-legacy-blob')
    const stored = storage.loadSessions()['sess-legacy-blob']

    console.log(JSON.stringify({
      returnedTexts: returned.map((message) => message.text),
      secondReadTexts: secondRead.map((message) => message.text),
      blobMessageCount: Array.isArray(stored.messages) ? stored.messages.length : -1,
      messageCount: stored.messageCount,
      lastMessageText: stored.lastMessageSummary?.text || null,
    }))
  `, { prefix: 'swarmclaw-message-repo-compact-' })

  assert.deepEqual(output.returnedTexts, [
    'first legacy prompt',
    'first legacy reply',
    'second legacy prompt',
  ])
  assert.deepEqual(output.secondReadTexts, output.returnedTexts)
  assert.equal(output.blobMessageCount, 0)
  assert.equal(output.messageCount, 3)
  assert.equal(output.lastMessageText, 'second legacy prompt')
})

test('bulk migration reports compaction for table-backed legacy blobs', () => {
  const output = runWithTempDataDir<{
    result: {
      migrated: number
      compacted: number
      skipped: number
      total: number
    }
    blobMessageCount: number
    messageCount: number
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod

    const messages = [
      { role: 'user', text: 'stale blob prompt', time: 10 },
      { role: 'assistant', text: 'stale blob reply', time: 20 },
    ]

    storage.saveSessions({
      'sess-table-backed-blob': {
        id: 'sess-table-backed-blob',
        name: 'Table backed blob session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    const db = storage.getDb()
    const insert = db.prepare('INSERT INTO session_messages (session_id, seq, data) VALUES (?, ?, ?)')
    messages.forEach((message, index) => {
      insert.run('sess-table-backed-blob', index, JSON.stringify(message))
    })

    const result = repo.migrateAllSessions()
    const stored = storage.loadSessions()['sess-table-backed-blob']

    console.log(JSON.stringify({
      result,
      blobMessageCount: Array.isArray(stored.messages) ? stored.messages.length : -1,
      messageCount: stored.messageCount,
    }))
  `, { prefix: 'swarmclaw-message-repo-migrate-report-' })

  assert.equal(output.result.migrated, 0)
  assert.equal(output.result.compacted, 1)
  assert.equal(output.result.skipped, 1)
  assert.equal(output.result.total, 1)
  assert.equal(output.blobMessageCount, 0)
  assert.equal(output.messageCount, 2)
})
