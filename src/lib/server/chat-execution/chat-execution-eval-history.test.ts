import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('executeSessionChatTurn persists internal eval user turns for same-thread recall', () => {
  const output = runWithTempDataDir<{
    recallText: string | null
    roles: string[]
    texts: string[]
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const providersMod = await import('@/lib/providers/index')
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
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
      extensions: [],
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
  `, {
    prefix: 'swarmclaw-chat-eval-history-',
    dataDir: 'data',
    browserProfilesDir: 'browser-profiles',
  })

  assert.match(String(output.recallText || ''), /Sunbird/)
  assert.deepEqual(output.roles, ['user', 'assistant', 'user', 'assistant'])
  assert.match(String(output.texts?.[0] || ''), /Project Kodiak uses the code name Sunbird/)
})
