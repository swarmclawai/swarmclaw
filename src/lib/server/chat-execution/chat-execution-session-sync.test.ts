import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chat-session-sync-'))
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

test('executeSessionChatTurn syncs updated agent runtime fields onto its thread session', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('@/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const providersMod = await import('@/lib/providers/index')
    const threadMod = await import('@/lib/server/agents/agent-thread-session')
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
    const ensureAgentThreadSession = threadMod.ensureAgentThreadSession
      || threadMod.default?.ensureAgentThreadSession
      || threadMod['module.exports']?.ensureAgentThreadSession
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
        async streamChat() {
          return 'synced'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      molly: {
        id: 'molly',
        name: 'Molly',
        description: 'Thread session sync test',
        provider: 'openai',
        model: 'old-model',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        heartbeatEnabled: false,
        heartbeatIntervalSec: null,
        plugins: ['memory'],
        createdAt: now,
        updatedAt: now,
      },
    })

    const session = ensureAgentThreadSession('molly')
    const sessionsBefore = storage.loadSessions()
    sessionsBefore[session.id].connectorContext = {
      connectorId: 'conn-stale',
      channelId: 'stale-channel',
      senderId: 'stale-user',
    }
    storage.saveSessions(sessionsBefore)
    const agents = storage.loadAgents()
    agents.molly.provider = 'test-provider'
    agents.molly.model = 'unit'
    agents.molly.plugins = []
    agents.molly.heartbeatEnabled = true
    agents.molly.heartbeatIntervalSec = 90
    agents.molly.updatedAt = now + 1
    storage.saveAgents(agents)

    await executeSessionChatTurn({
      sessionId: session.id,
      message: 'hello',
      runId: 'run-session-sync',
    })

    const persisted = storage.loadSession(session.id)
    console.log(JSON.stringify({
      provider: persisted?.provider || null,
      model: persisted?.model || null,
      plugins: persisted?.plugins || [],
      heartbeatEnabled: persisted?.heartbeatEnabled ?? null,
      heartbeatIntervalSec: persisted?.heartbeatIntervalSec ?? null,
      connectorContext: persisted?.connectorContext || null,
    }))
  `)

  assert.equal(output.provider, 'test-provider')
  assert.equal(output.model, 'unit')
  assert.deepEqual(output.plugins, [])
  assert.equal(output.heartbeatEnabled, true)
  assert.equal(output.heartbeatIntervalSec, 90)
  assert.equal(output.connectorContext, null)
})

test('executeSessionChatTurn keeps tool-only heartbeats off the visible main-thread history and clears stale connector state', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('@/lib/server/storage')
    const providersMod = await import('@/lib/providers/index')
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
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
        async streamChat(opts) {
          opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Sent the ferry status to WhatsApp.' }) + '\\n')
          return ''
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      hal: {
        id: 'hal',
        name: 'Hal2k',
        description: 'Heartbeat hygiene test',
        provider: 'test-provider',
        model: 'unit',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        heartbeatEnabled: true,
        heartbeatIntervalSec: 60,
        plugins: [],
        threadSessionId: 'agent_thread',
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      agent_thread: {
        id: 'agent_thread',
        name: 'Hal2k',
        cwd: process.env.WORKSPACE_DIR,
        user: 'default',
        provider: 'test-provider',
        model: 'unit',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [
          { role: 'user', text: 'seed user message', time: now - 1000 },
        ],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'hal',
        shortcutForAgentId: 'hal',
        plugins: [],
        connectorContext: {
          connectorId: 'conn-stale',
          channelId: 'wrong-chat',
          senderId: 'wrong-user',
        },
      },
    })

    await executeSessionChatTurn({
      sessionId: 'agent_thread',
      message: 'AGENT_HEARTBEAT_WAKE\\nInternal connector follow-up only',
      internal: true,
      source: 'heartbeat-wake',
      heartbeatConfig: {
        ackMaxChars: 300,
        showOk: false,
        showAlerts: true,
        target: null,
        deliveryMode: 'tool_only',
      },
      runId: 'run-heartbeat-tool-only',
    })

    const persisted = storage.loadSession('agent_thread')
    console.log(JSON.stringify({
      connectorContext: persisted?.connectorContext || null,
      messageCount: persisted?.messages?.length || 0,
      lastMessageText: persisted?.messages?.at(-1)?.text || null,
      heartbeatKinds: (persisted?.messages || []).filter((entry) => entry.kind === 'heartbeat').length,
    }))
  `)

  assert.equal(output.connectorContext, null)
  assert.equal(output.messageCount, 1)
  assert.equal(output.lastMessageText, 'seed user message')
  assert.equal(output.heartbeatKinds, 0)
})
