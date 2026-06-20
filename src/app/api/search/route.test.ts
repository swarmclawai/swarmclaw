import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('global search finds repo-backed session messages after blob compaction', () => {
  const output = runWithTempDataDir<{
    messageTitles: string[]
    messageIndexes: number[]
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const repoMod = await import('@/lib/server/messages/message-repository')
    const routeMod = await import('./src/app/api/search/route')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    storage.saveAgents({
      'agent-search': {
        id: 'agent-search',
        name: 'Search Agent',
        description: 'Search fixture',
        provider: 'openai',
        model: 'gpt-5',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    storage.saveSessions({
      'sess-search': {
        id: 'sess-search',
        name: 'Search Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'tester',
        provider: 'openai',
        model: 'gpt-5',
        agentId: 'agent-search',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    })

    repo.appendMessage('sess-search', { role: 'user', text: 'ordinary setup note', time: 10 })
    repo.appendMessage('sess-search', { role: 'assistant', text: 'needle-backed answer from the message table', time: 20 })

    const response = await route.GET(new Request('http://local/api/search?q=needle-backed'))
    const payload = await response.json()
    const messageResults = payload.results.filter((result) => result.type === 'message')

    console.log(JSON.stringify({
      messageTitles: messageResults.map((result) => result.title),
      messageIndexes: messageResults.map((result) => result.messageIndex),
    }))
  `, { prefix: 'swarmclaw-search-repo-messages-' })

  assert.deepEqual(output.messageTitles, ['needle-backed answer from the message table'])
  assert.deepEqual(output.messageIndexes, [1])
})
