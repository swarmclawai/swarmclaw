import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir as runWithSharedTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

function runWithTempDataDir<T = unknown>(script: string): T {
  return runWithSharedTempDataDir<T>(script, {
    prefix: 'swarmclaw-chat-disabled-',
    dataDir: 'data',
    browserProfilesDir: 'browser-profiles',
  })
}

test('executeSessionChatTurn persists a visible error for disabled agents', () => {
  const output = runWithTempDataDir<{
    error: string | null
    text: string | null
    persisted: boolean
    lastRole: string | null
    lastText: string | null
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const threadMod = await import('@/lib/server/agents/agent-thread-session')
    const ensureAgentThreadSession = threadMod.ensureAgentThreadSession
      || threadMod.default?.ensureAgentThreadSession
      || threadMod['module.exports']?.ensureAgentThreadSession
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
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
        extensions: ['memory'],
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
