import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('executeSessionChatTurn persists citations and retrieval traces on grounded assistant messages', () => {
  const output = runWithTempDataDir<{
    persisted: boolean
    resultCitationCount: number
    resultSelectorStatus: string | null
    messageCitationCount: number
    messageTraceHitCount: number
    messageSelectorStatus: string | null
    messageSourceTitle: string | null
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const providersMod = await import('@/lib/providers/index')
    const threadMod = await import('@/lib/server/agents/agent-thread-session')
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
    const messageRepoMod = await import('@/lib/server/messages/message-repository')
    const knowledgeMod = await import('@/lib/server/knowledge-sources')

    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const ensureAgentThreadSession = threadMod.ensureAgentThreadSession
      || threadMod.default?.ensureAgentThreadSession
      || threadMod['module.exports']?.ensureAgentThreadSession
    const executeSessionChatTurn = execMod.executeSessionChatTurn
      || execMod.default?.executeSessionChatTurn
      || execMod['module.exports']?.executeSessionChatTurn
    const getMessages = messageRepoMod.getMessages
      || messageRepoMod.default?.getMessages
      || messageRepoMod['module.exports']?.getMessages
    const knowledge = knowledgeMod.default || knowledgeMod
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
        async streamChat() {
          return 'Use blue green deployment for the gateway migration so rollback stays simple.'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      molly: {
        id: 'molly',
        name: 'Molly',
        description: 'Grounding test',
        provider: 'test-provider',
        model: 'unit',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        proactiveMemory: true,
        extensions: ['memory'],
        createdAt: now,
        updatedAt: now,
      },
    })

    await knowledge.createKnowledgeSource({
      kind: 'manual',
      title: 'Gateway Migration Runbook',
      content: 'Use blue green deployment for gateway migrations so rollback stays simple and downtime stays low.',
      tags: ['deploy'],
    })

    const session = ensureAgentThreadSession('molly')
    const result = await executeSessionChatTurn({
      sessionId: session.id,
      message: 'gateway blue green rollback',
      runId: 'run-grounding-chat',
    })

    const messages = getMessages(session.id)
    const lastMessage = messages[messages.length - 1]

    console.log(JSON.stringify({
      persisted: result.persisted || false,
      resultCitationCount: Array.isArray(result.citations) ? result.citations.length : 0,
      resultSelectorStatus: result.retrievalTrace?.selectorStatus || null,
      messageCitationCount: Array.isArray(lastMessage?.citations) ? lastMessage.citations.length : 0,
      messageTraceHitCount: Array.isArray(lastMessage?.retrievalTrace?.hits) ? lastMessage.retrievalTrace.hits.length : 0,
      messageSelectorStatus: lastMessage?.retrievalTrace?.selectorStatus || null,
      messageSourceTitle: lastMessage?.citations?.[0]?.sourceTitle || null,
    }))
  `, {
    prefix: 'swarmclaw-chat-grounding-',
    dataDir: 'data',
    browserProfilesDir: 'browser-profiles',
  })

  assert.equal(output.persisted, true)
  assert.equal(output.resultCitationCount >= 1, true)
  assert.equal(output.resultSelectorStatus, 'selected')
  assert.equal(output.messageCitationCount >= 1, true)
  assert.equal(output.messageTraceHitCount >= 1, true)
  assert.equal(output.messageSelectorStatus, 'selected')
  assert.equal(output.messageSourceTitle, 'Gateway Migration Runbook')
})
