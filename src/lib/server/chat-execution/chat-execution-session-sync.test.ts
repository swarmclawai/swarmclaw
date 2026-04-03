import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir as runWithSharedTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

function runWithTempDataDir<T = unknown>(script: string): T {
  return runWithSharedTempDataDir<T>(script, {
    prefix: 'swarmclaw-chat-session-sync-',
    dataDir: 'data',
    browserProfilesDir: 'browser-profiles',
  })
}

test('executeSessionChatTurn syncs updated agent runtime fields onto its thread session', () => {
  const output = runWithTempDataDir<{
    provider: string | null
    model: string | null
    extensions: string[]
    heartbeatEnabled: boolean | null
    heartbeatIntervalSec: number | null
    connectorContext: Record<string, unknown> | null
  }>(`
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
        extensions: ['memory'],
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
    agents.molly.extensions = []
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
      extensions: persisted?.extensions || [],
      heartbeatEnabled: persisted?.heartbeatEnabled ?? null,
      heartbeatIntervalSec: persisted?.heartbeatIntervalSec ?? null,
      connectorContext: persisted?.connectorContext || null,
    }))
  `)

  assert.equal(output.provider, 'test-provider')
  assert.equal(output.model, 'unit')
  assert.deepEqual(output.extensions, [])
  assert.equal(output.heartbeatEnabled, true)
  assert.equal(output.heartbeatIntervalSec, 90)
  assert.equal(output.connectorContext, null)
})

test('executeSessionChatTurn keeps tool-only heartbeats off the visible main-thread history and clears stale connector state', () => {
  const output = runWithTempDataDir<{
    connectorContext: Record<string, unknown> | null
    messageCount: number
    lastMessageText: string | null
    heartbeatKinds: number
  }>(`
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
        extensions: [],
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
        extensions: [],
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

test('executeSessionChatTurn hides internal main-loop followup output from the visible transcript', () => {
  const output = runWithTempDataDir<{
    messageCount: number
    lastMessageText: string | null
    hasStreamingArtifacts: boolean
  }>(`
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
          opts.write('data: ' + JSON.stringify({ t: 'd', text: 'Internal partial response.' }) + '\\n\\n')
          return 'Internal final response with tool context.'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      hal: {
        id: 'hal',
        name: 'Hal2k',
        description: 'Hidden followup test',
        provider: 'test-provider',
        model: 'unit',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        heartbeatEnabled: true,
        heartbeatIntervalSec: 60,
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
          { role: 'user', text: 'Build a site.', time: now - 2000 },
          { role: 'assistant', text: 'Here is the visible answer.', time: now - 1000, kind: 'chat' },
        ],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'hal',
        shortcutForAgentId: 'hal',
      },
    })

    await executeSessionChatTurn({
      sessionId: 'agent_thread',
      message: 'Continue the objective.',
      internal: true,
      source: 'main-loop-followup',
      runId: 'run-hidden-followup',
    })

    await new Promise((resolve) => setTimeout(resolve, 450))

    const persisted = storage.loadSession('agent_thread')
    console.log(JSON.stringify({
      messageCount: persisted?.messages?.length || 0,
      lastMessageText: persisted?.messages?.at(-1)?.text || null,
      hasStreamingArtifacts: (persisted?.messages || []).some((entry) => entry.streaming === true),
    }))
  `)

  assert.equal(output.messageCount, 2)
  assert.equal(output.lastMessageText, 'Here is the visible answer.')
  assert.equal(output.hasStreamingArtifacts, false)
})

test('executeSessionChatTurn forces external connector sessions onto session-scoped memory', () => {
  const output = runWithTempDataDir<{
    memoryScopeMode: string | null
    connectorContext: { isOwnerConversation?: boolean } | null
  }>(`
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
        async streamChat() {
          return 'connector reply'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      inbox: {
        id: 'inbox',
        name: 'Inbox Agent',
        description: 'External connector scope test',
        provider: 'test-provider',
        model: 'unit',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        heartbeatEnabled: false,
        heartbeatIntervalSec: null,
        memoryScopeMode: 'agent',
        extensions: ['memory'],
        createdAt: now,
        updatedAt: now,
      },
    })

    storage.saveSessions({
      connector_peer: {
        id: 'connector_peer',
        name: 'connector:whatsapp:conn-whats:peer:447700900000',
        cwd: process.env.WORKSPACE_DIR,
        user: 'connector',
        provider: 'test-provider',
        model: 'unit',
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'inbox',
        extensions: ['memory'],
        memoryScopeMode: 'agent',
        connectorContext: {
          connectorId: 'conn-whats',
          platform: 'whatsapp',
          channelId: '447700900000@s.whatsapp.net',
          senderId: '447700900000@s.whatsapp.net',
          senderName: 'External Sender',
          isOwnerConversation: false,
        },
      },
    })

    await executeSessionChatTurn({
      sessionId: 'connector_peer',
      message: 'remember my dog is called Kiki',
      runId: 'run-connector-session-scope',
    })

    const persisted = storage.loadSession('connector_peer')
    console.log(JSON.stringify({
      memoryScopeMode: persisted?.memoryScopeMode || null,
      connectorContext: persisted?.connectorContext || null,
    }))
  `)

  assert.equal(output.memoryScopeMode, 'session')
  assert.equal(output.connectorContext?.isOwnerConversation, false)
})

test('executeSessionChatTurn applies lifecycle hooks for model resolution and message persistence', () => {
  const output = runWithTempDataDir<{
    lastMessageText: string
    marks: string[]
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const providersMod = await import('@/lib/providers/index')
    const extMod = await import('@/lib/server/extensions')
    const execMod = await import('@/lib/server/chat-execution/chat-execution')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod
    const executeSessionChatTurn = execMod.executeSessionChatTurn
      || execMod.default?.executeSessionChatTurn
      || execMod['module.exports']?.executeSessionChatTurn
    const providers = providersMod.PROVIDERS
      || providersMod.default?.PROVIDERS
      || providersMod['module.exports']?.PROVIDERS
    const extensionManager = extMod.getExtensionManager
      ? extMod.getExtensionManager()
      : extMod.default?.getExtensionManager?.()

    const lifecycleMarks = []
    extensionManager.registerBuiltin('lifecycle_hooks_test', {
      name: 'Lifecycle Hooks Test',
      hooks: {
        beforeModelResolve: () => ({
          providerOverride: 'claude-cli',
          modelOverride: 'resolved-model',
        }),
        beforeMessageWrite: ({ message, phase }) => {
          lifecycleMarks.push(phase || 'unknown')
          return {
            message: {
              ...message,
              text: message.role === 'assistant' ? message.text + ' [stored]' : message.text,
            },
          }
        },
        sessionStart: () => {
          lifecycleMarks.push('session_start')
        },
      },
    })

    providers['claude-cli'] = {
      id: 'claude-cli',
      name: 'Resolved Provider',
      models: ['resolved-model'],
      requiresApiKey: false,
      requiresEndpoint: false,
      handler: {
        async streamChat(opts) {
          lifecycleMarks.push('provider:' + opts.session.provider + ':' + opts.session.model)
          return 'resolved response'
        },
      },
    }

    const now = Date.now()
    storage.saveAgents({
      lifecycle: {
        id: 'lifecycle',
        name: 'Lifecycle Agent',
        description: 'Lifecycle hook integration test',
        provider: 'openai',
        model: 'seed-model',
        credentialId: null,
        apiEndpoint: null,
        fallbackCredentialIds: [],
        disabled: false,
        heartbeatEnabled: false,
        heartbeatIntervalSec: null,
        extensions: ['lifecycle_hooks_test'],
        createdAt: now,
        updatedAt: now,
      },
    })
    storage.saveSessions({
      lifecycle_session: {
        id: 'lifecycle_session',
        name: 'Lifecycle Session',
        cwd: process.env.WORKSPACE_DIR,
        user: 'default',
        provider: 'openai',
        model: 'seed-model',
        claudeSessionId: null,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        sessionType: 'human',
        agentId: 'lifecycle',
        extensions: ['lifecycle_hooks_test'],
      },
    })

    await executeSessionChatTurn({
      sessionId: 'lifecycle_session',
      message: 'hello lifecycle',
      runId: 'run-lifecycle-hooks',
    })

    const persisted = storage.loadSession('lifecycle_session')
    console.log(JSON.stringify({
      lastMessageText: persisted?.messages?.at(-1)?.text || null,
      marks: lifecycleMarks,
    }))
  `)

  assert.equal(output.lastMessageText.startsWith('resolved response'), true)
  assert.equal(output.lastMessageText.endsWith('[stored]'), true)
  assert.equal(output.marks.includes('session_start'), true)
  assert.equal(output.marks.includes('provider:claude-cli:resolved-model'), true)
  assert.equal(output.marks.includes('user'), true)
  assert.equal(output.marks.includes('assistant_final'), true)
})
