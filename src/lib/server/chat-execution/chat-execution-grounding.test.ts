import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chat-grounding-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        BROWSER_PROFILES_DIR: path.join(tempDir, 'browser-profiles'),
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('executeSessionChatTurn persists citations and retrieval traces on grounded assistant messages', () => {
  const output = runWithTempDataDir(`
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
  `)

  assert.equal(output.persisted, true)
  assert.equal(output.resultCitationCount >= 1, true)
  assert.equal(output.resultSelectorStatus, 'selected')
  assert.equal(output.messageCitationCount >= 1, true)
  assert.equal(output.messageTraceHitCount >= 1, true)
  assert.equal(output.messageSelectorStatus, 'selected')
  assert.equal(output.messageSourceTitle, 'Gateway Migration Runbook')
})
