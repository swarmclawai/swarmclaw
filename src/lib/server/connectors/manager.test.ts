import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '../test-utils/run-with-temp-data-dir'

import { sanitizeConnectorOutboundContent } from './manager'

describe('sanitizeConnectorOutboundContent', () => {
  it('strips hidden control tokens from captions without suppressing the media send itself', () => {
    assert.deepEqual(
      sanitizeConnectorOutboundContent({
        text: 'Here is the attachment',
        caption: 'NO_MESSAGE',
      }),
      {
        sanitizedText: 'Here is the attachment',
        suppressHiddenText: false,
        sanitizedCaptionText: '',
        sanitizedCaption: undefined,
      },
    )
  })

  it('suppresses pure hidden-control text payloads', () => {
    assert.deepEqual(
      sanitizeConnectorOutboundContent({
        text: 'HEARTBEAT_OK',
        caption: 'Looks good',
      }),
      {
        sanitizedText: '',
        suppressHiddenText: true,
        sanitizedCaptionText: 'Looks good',
        sanitizedCaption: 'Looks good',
      },
    )
  })

  it('mirrors direct WhatsApp inbound and assistant replies into the session transcript', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Roger that via WhatsApp' }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      const connector = storage.loadConnectors().conn_1
      const response = await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '15550001111@s.whatsapp.net',
        senderId: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Hello from WhatsApp',
        messageId: 'in-1',
        isGroup: false,
      })

      const sessions = storage.loadSessions()
      const directSession = Object.values(sessions).find((entry) => entry.id !== 'agent_thread')
      const mainSession = sessions.agent_thread
      console.log(JSON.stringify({ response, directSession, mainSession }))
    `)

    assert.equal(output.response, 'Roger that via WhatsApp')
    assert.equal(output.directSession.messages.length, 2)
    assert.equal(output.directSession.messages[0].role, 'user')
    assert.equal(output.directSession.messages[0].source.platform, 'whatsapp')
    assert.equal(output.directSession.messages[0].source.messageId, 'in-1')
    assert.equal(output.directSession.messages[1].role, 'assistant')
    assert.equal(output.directSession.messages[1].text, 'Roger that via WhatsApp')
    assert.equal(output.directSession.messages[1].source.platform, 'whatsapp')
    assert.equal(output.directSession.messages[1].source.replyToMessageId, 'in-1')
    assert.equal(output.mainSession.messages.length, 2)
    assert.equal(output.mainSession.messages[0].source.platform, 'whatsapp')
    assert.equal(output.mainSession.messages[0].source.senderName, 'Alice')
    assert.equal(output.mainSession.messages[0].historyExcluded, true)
    assert.equal(output.mainSession.messages[1].source.platform, 'whatsapp')
    assert.equal(output.mainSession.messages[1].text, 'Roger that via WhatsApp')
    assert.equal(output.mainSession.messages[1].historyExcluded, true)
  })

  it('queues connector heartbeat wakes on the agent thread session and records the system event there', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const heartbeatMod = await import('@/lib/server/runtime/heartbeat-wake')
      const systemEventsMod = await import('@/lib/server/runtime/system-events')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod
      const heartbeat = heartbeatMod.default || heartbeatMod
      const systemEvents = systemEventsMod.default || systemEventsMod

      const now = Date.now()
      heartbeat.resetHeartbeatWakeStateForTests()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Heartbeat target check' }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      const connector = storage.loadConnectors().conn_1
      await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '15550001111@s.whatsapp.net',
        senderId: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Did you get this?',
        messageId: 'in-thread-target',
        isGroup: false,
      })

      const sessions = storage.loadSessions()
      const directSession = Object.values(sessions).find((entry) => entry.id !== 'agent_thread')
      console.log(JSON.stringify({
        wake: heartbeat.snapshotPendingHeartbeatWakesForTests()[0] || null,
        threadEvents: systemEvents.peekSystemEvents('agent_thread'),
        directEvents: directSession ? systemEvents.peekSystemEvents(directSession.id) : [],
        directSessionId: directSession?.id || null,
      }))
    `)

    assert.equal(output.wake.sessionId, 'agent_thread')
    assert.equal(output.wake.agentId, 'agent_1')
    assert.equal(output.threadEvents.length, 1)
    assert.match(output.threadEvents[0].text, /Inbound message from whatsapp: Did you get this\?/i)
    assert.equal(output.directEvents.length, 0)
    assert.ok(output.directSessionId)
  })

  it('mirrors same-channel connector_message_tool sends when the agent suppresses visible text', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'NO_MESSAGE' }) + '\\n')
            return ''
          },
        },
      }
      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: ['connector_message_tool'],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({})

      manager.setStreamAgentChatForTest(async (opts) => {
        opts.write('data: ' + JSON.stringify({
          t: 'tool_call',
          toolName: 'connector_message_tool',
          toolInput: JSON.stringify({
            action: 'send',
            to: '15550001111@s.whatsapp.net',
            message: 'Sent from tool path',
          }),
          toolCallId: 'call-1',
        }) + '\\n')
        opts.write('data: ' + JSON.stringify({
          t: 'tool_result',
          toolName: 'connector_message_tool',
          toolOutput: JSON.stringify({
            status: 'sent',
            to: '15550001111@s.whatsapp.net',
            messageId: 'wa-out-1',
          }),
          toolCallId: 'call-1',
        }) + '\\n')
        return {
          fullText: 'NO_MESSAGE',
          finalResponse: 'NO_MESSAGE',
          toolEvents: [],
        }
      })

      try {
        const connector = storage.loadConnectors().conn_1
        const response = await manager.routeConnectorMessageForTest(connector, {
          platform: 'whatsapp',
          channelId: '15550001111@s.whatsapp.net',
          senderId: '15550001111@s.whatsapp.net',
          senderName: 'Alice',
          text: 'Send it on WhatsApp',
          messageId: 'in-2',
          isGroup: false,
        })
        const sessions = storage.loadSessions()
        const directSession = Object.values(sessions).find((entry) => String(entry.name || '').startsWith('connector:'))
        const mainSession = Object.values(sessions).find((entry) => entry.id !== directSession?.id)
        console.log(JSON.stringify({ response, directSession, mainSession }))
      } finally {
        manager.setStreamAgentChatForTest(null)
      }
    `)

    assert.equal(output.response, 'NO_MESSAGE')
    assert.equal(output.directSession.messages.length, 2)
    assert.equal(output.directSession.messages[1].role, 'assistant')
    assert.equal(output.directSession.messages[1].text, 'Sent from tool path')
    assert.equal(output.directSession.messages[1].source.platform, 'whatsapp')
    assert.equal(output.directSession.messages[1].source.messageId, 'wa-out-1')
    assert.equal(output.directSession.connectorContext.lastOutboundMessageId, 'wa-out-1')
    assert.equal(output.mainSession.messages.length, 2)
    assert.equal(output.mainSession.messages.every((entry: any) => entry.historyExcluded === true), true)
  })

  it('accepts WhatsApp allowlist matches through senderIdAlt when the primary sender id is a lid', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Allowlist matched' }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: {
            inboundDebounceMs: 0,
            dmPolicy: 'allowlist',
            allowFrom: '15550001111',
          },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({})

      const connector = storage.loadConnectors().conn_1
      const response = await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '199900000001@lid',
        channelIdAlt: '15550001111@s.whatsapp.net',
        senderId: '199900000001@lid',
        senderIdAlt: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Hello from a lid sender',
        messageId: 'in-3',
        isGroup: false,
      })

      const session = Object.values(storage.loadSessions())[0]
      console.log(JSON.stringify({ response, session }))
    `)

    assert.equal(output.response, 'Allowlist matched')
    assert.equal(output.session.messages[0].source.senderId, '199900000001@lid')
    assert.equal(output.session.messages[0].source.messageId, 'in-3')
  })

  it('reuses the same direct WhatsApp session when a contact flips from lid to phone jid', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Reply: ' + String(opts.message || '').slice(0, 32) }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({})

      const connector = storage.loadConnectors().conn_1
      await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '199900000001@lid',
        channelIdAlt: '15550001111@s.whatsapp.net',
        senderId: '199900000001@lid',
        senderIdAlt: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'First lid message',
        messageId: 'in-lid',
        isGroup: false,
      })
      await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '15550001111@s.whatsapp.net',
        senderId: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Second phone-jid message',
        messageId: 'in-phone',
        isGroup: false,
      })

      const directSessions = Object.values(storage.loadSessions())
        .filter((entry) => String(entry.name || '').startsWith('connector:'))
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          connectorContext: entry.connectorContext,
          messages: entry.messages.map((message) => ({
            role: message.role,
            text: message.text,
            source: message.source || null,
          })),
        }))
      console.log(JSON.stringify({ directSessions }))
    `)

    assert.equal(output.directSessions.length, 1)
    assert.equal(output.directSessions[0].messages.length, 4)
    assert.equal(output.directSessions[0].connectorContext.channelId, '15550001111@s.whatsapp.net')
    assert.equal(output.directSessions[0].connectorContext.channelIdAlt, '15550001111@s.whatsapp.net')
    assert.equal(output.directSessions[0].connectorContext.senderIdAlt, '15550001111@s.whatsapp.net')
    assert.deepEqual(
      output.directSessions[0].messages.filter((message: { role: string }) => message.role === 'user').map((message: { source: { channelId?: string | null } | null }) => message.source?.channelId),
      ['199900000001@lid', '15550001111@s.whatsapp.net'],
    )
  })

  it('routes send_voice_note to the current connector conversation when an audio file already exists', () => {
    const output = runWithTempDataDir(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const pluginsMod = await import('./src/lib/server/plugins')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const plugins = pluginsMod.default || pluginsMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      const sent = []
      plugins.getPluginManager().registerBuiltin('test-voice-connector-plugin', {
        name: 'Test Voice Connector Plugin',
        connectors: [{
          id: 'test-voice',
          name: 'Test Voice',
          description: 'Test voice connector',
          startListener: async () => async () => {},
          sendMessage: async (channelId, text, options) => {
            sent.push({ channelId, text, options })
            return { messageId: 'voice-out-1' }
          },
        }],
      })

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'anthropic',
          model: 'claude-test',
          plugins: ['manage_connectors'],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_voice: {
          id: 'conn_voice',
          name: 'Test Voice Connector',
          platform: 'test-voice',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      const voicePath = path.join(process.env.DATA_DIR, 'gran-voice.mp3')
      fs.writeFileSync(voicePath, Buffer.from('fake-mp3'))

      storage.saveSessions({
        session_1: {
          id: 'session_1',
          name: 'connector:whatsapp:gran',
          cwd: process.env.WORKSPACE_DIR,
          user: 'connector',
          provider: 'anthropic',
          model: 'claude-test',
          claudeSessionId: null,
          messages: [{
            role: 'user',
            text: 'Send my gran a voice note',
            time: now,
            source: {
              platform: 'whatsapp',
              connectorId: 'conn_voice',
              connectorName: 'Test Voice Connector',
              channelId: '278200000001@s.whatsapp.net',
              senderId: '278200000001@s.whatsapp.net',
              senderName: 'Gran',
            },
          }],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: ['manage_connectors'],
          connectorContext: {
            connectorId: 'conn_voice',
            platform: 'whatsapp',
            channelId: '278200000001@s.whatsapp.net',
            senderId: '278200000001@s.whatsapp.net',
            senderName: 'Gran',
          },
        },
      })

      await manager.startConnector('conn_voice')
      const built = await toolsApi.buildSessionTools(process.cwd(), ['manage_connectors'], {
        sessionId: 'session_1',
        agentId: 'agent_1',
        platformAssignScope: 'self',
      })

      try {
        const connectorTool = built.tools.find((tool) => tool.name === 'connector_message_tool')
        const raw = await connectorTool.invoke({
          action: 'send_voice_note',
          connectorId: 'conn_voice',
          mediaPath: voicePath,
        })
        console.log(JSON.stringify({ result: JSON.parse(String(raw)), sent }))
      } finally {
        await built.cleanup()
        await manager.stopConnector('conn_voice')
      }
    `)

    assert.equal(output.result.status, 'voice_sent')
    assert.equal(output.result.to, '278200000001@s.whatsapp.net')
    assert.equal(output.sent.length, 1)
    assert.equal(output.sent[0].channelId, '278200000001@s.whatsapp.net')
    assert.match(output.sent[0].text, /gran-voice\.mp3/)
  })

  it('restarts a stale connector automatically when an outbound send fails with connection closed', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const plugins = pluginsMod.default || pluginsMod

      const now = Date.now()
      let startCount = 0
      const attempts = []
      plugins.getPluginManager().registerBuiltin('test-recover-connector-plugin', {
        name: 'Test Recover Connector Plugin',
        connectors: [{
          id: 'test-recover',
          name: 'Test Recover',
          description: 'Test connector with recoverable send failure',
          startListener: async () => {
            startCount += 1
            return async () => {}
          },
          sendMessage: async (channelId, text, options) => {
            attempts.push({ channelId, text, options })
            if (attempts.length === 1) throw new Error('Connection Closed')
            return { messageId: 'recover-1' }
          },
        }],
      })

      storage.saveSettings({})
      storage.saveConnectors({
        conn_recover: {
          id: 'conn_recover',
          name: 'Recover Connector',
          platform: 'test-recover',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      try {
        await manager.startConnector('conn_recover')
        const result = await manager.sendConnectorMessage({
          connectorId: 'conn_recover',
          channelId: '15550001111',
          text: 'hello after restart',
        })
        const health = Object.values(storage.loadConnectorHealth()).filter((entry) => entry.connectorId === 'conn_recover')
        console.log(JSON.stringify({ result, attempts, startCount, health }))
      } finally {
        await manager.stopConnector('conn_recover')
      }
    `)

    assert.equal(output.result.messageId, 'recover-1')
    assert.equal(output.attempts.length, 2)
    assert.equal(output.startCount, 2)
    assert.equal(output.health.some((entry: { event?: string }) => entry.event === 'disconnected'), true)
  })

  it('does not persist connector routing state onto a non-direct session during outbound sends', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const plugins = pluginsMod.default || pluginsMod

      const sent = []
      const now = Date.now()
      plugins.getPluginManager().registerBuiltin('test-send-plugin', {
        name: 'Test Send Plugin',
        connectors: [{
          id: 'test-send',
          name: 'Test Send',
          description: 'Outbound send capture',
          startListener: async () => async () => {},
          sendMessage: async (channelId, text, options) => {
            sent.push({ channelId, text, options })
            return { messageId: 'out-1' }
          },
        }],
      })

      storage.saveSettings({})
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'Test Send Connector',
          platform: 'test-send',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        main_thread: {
          id: 'main_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'anthropic',
          model: 'claude-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      try {
        await manager.startConnector('conn_1')
        const result = await manager.sendConnectorMessage({
          connectorId: 'conn_1',
          channelId: '15550001111@s.whatsapp.net',
          text: 'hello',
          sessionId: 'main_thread',
        })
        const session = storage.loadSessions().main_thread
        console.log(JSON.stringify({ result, session, sent }))
      } finally {
        await manager.stopConnector('conn_1')
      }
    `)

    assert.equal(output.result.messageId, 'out-1')
    assert.equal(output.sent.length, 1)
    assert.equal(output.session.connectorContext || null, null)
  })

  it('does not auto-send a second connector reply from a non-direct main-thread heartbeat after a direct connector reply', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const chatExecMod = await import('./src/lib/server/chat-execution/chat-execution')
      const providersMod = await import('./src/lib/providers/index')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const chatExec = chatExecMod.default || chatExecMod
      const providers = providersMod.default || providersMod
      const plugins = pluginsMod.default || pluginsMod

      const sent = []
      const now = Date.now()
      plugins.getPluginManager().registerBuiltin('test-dup-heartbeat-plugin', {
        name: 'Test Dup Heartbeat Plugin',
        connectors: [{
          id: 'test-dup-heartbeat',
          name: 'Test Dup Heartbeat',
          description: 'Captures outbound sends for duplication regressions',
          startListener: async () => async () => {},
          sendMessage: async (channelId, text, options) => {
            sent.push({ channelId, text, options })
            return { messageId: 'out-' + sent.length }
          },
        }],
      })

      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            const message = String(opts.message || '')
            const text = message.includes('AGENT_HEARTBEAT')
              ? 'Sent the ferry status to your WhatsApp.'
              : 'Direct connector reply'
            opts.write('data: ' + JSON.stringify({ t: 'r', text }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Hal2k',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          heartbeatEnabled: true,
          heartbeatIntervalSec: 60,
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'test-dup-heartbeat',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0, botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
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
          model: 'test-model',
          claudeSessionId: null,
          codexThreadId: null,
          opencodeSessionId: null,
          delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          shortcutForAgentId: 'agent_1',
          plugins: [],
          connectorContext: {
            connectorId: 'conn_1',
            channelId: 'poisoned-main-thread',
            senderId: 'wrong-user',
          },
        },
      })

      try {
        await manager.startConnector('conn_1')
        const connector = storage.loadConnectors().conn_1
        const directResponse = await manager.routeConnectorMessageForTest(connector, {
          platform: 'whatsapp',
          channelId: '15550001111@s.whatsapp.net',
          senderId: '15550001111@s.whatsapp.net',
          senderName: 'Alice',
          text: 'Did you get this?',
          messageId: 'in-1',
          isGroup: false,
        })

        await chatExec.executeSessionChatTurn({
          sessionId: 'agent_thread',
          message: 'AGENT_HEARTBEAT_TICK\\nConnector follow-up sweep',
          internal: true,
          source: 'heartbeat',
          runId: 'run-main-heartbeat',
          heartbeatConfig: {
            ackMaxChars: 300,
            showOk: false,
            showAlerts: true,
            target: null,
          },
        })

        const sessions = storage.loadSessions()
        const directSession = Object.values(sessions).find((entry) =>
          entry.id !== 'agent_thread' && String(entry.name || '').startsWith('connector:')
        )
        console.log(JSON.stringify({
          directResponse,
          sent,
          mainThread: sessions.agent_thread,
          directSessionId: directSession?.id || null,
        }))
      } finally {
        await manager.stopConnector('conn_1')
      }
    `)

    assert.equal(output.directResponse, 'Direct connector reply')
    assert.equal(output.sent.length, 0)
    assert.ok(output.directSessionId)
    assert.equal(output.mainThread.connectorContext || null, null)
  })

  it('suppresses replies when a matched sender boundary memory says not to answer unless directly addressed', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const pluginsMod = await import('./src/lib/server/plugins')
      const memoryDbMod = await import('./src/lib/server/memory/memory-db')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod
      const plugins = pluginsMod.default || pluginsMod
      const memoryDbApi = memoryDbMod.default || memoryDbMod
      const memoryDb = memoryDbApi.getMemoryDb()

      let providerCalls = 0
      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async () => {
            providerCalls += 1
            return 'should not be sent'
          },
        },
      }

      plugins.getPluginManager().registerBuiltin('test-quiet-boundary-connector-plugin', {
        name: 'Test Quiet Boundary Connector Plugin',
        connectors: [{
          id: 'test-quiet',
          name: 'Test Quiet',
          description: 'Quiet boundary test connector',
          startListener: async () => async () => {},
          sendMessage: async () => ({ messageId: 'unused' }),
        }],
      })

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Hal',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'test-quiet',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Hal',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      memoryDb.add({
        agentId: 'agent_1',
        sessionId: null,
        category: 'identity/preferences',
        title: 'Wife communication rule',
        content: 'Wayde\\'s wife (+44 7958 047282): Do NOT respond unless she addresses Hal directly or mentions Hal directly. If unsure, verify whether the message is for Wayde or Hal before responding.',
      })

      const connector = storage.loadConnectors().conn_1
      const response = await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '447958047282@s.whatsapp.net',
        senderId: '447958047282@s.whatsapp.net',
        senderName: 'Wayde Wife',
        text: 'Dinner is ready for Wayde.',
        messageId: 'in-quiet-1',
        isGroup: false,
      })

      const sessions = storage.loadSessions()
      const directSession = Object.values(sessions).find((entry) => entry.id !== 'agent_thread')
      console.log(JSON.stringify({
        response,
        providerCalls,
        directSessionMessageCount: directSession?.messages?.length || 0,
        mainThreadMessageCount: sessions.agent_thread?.messages?.length || 0,
      }))
    `)

    assert.equal(output.response, 'NO_MESSAGE')
    assert.equal(output.providerCalls, 0)
    assert.equal(output.directSessionMessageCount, 0)
    assert.equal(output.mainThreadMessageCount, 0)
  })

  it('requires an explicit target when a shared thread only has mirrored connector history', () => {
    const output = runWithTempDataDir(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const pluginsMod = await import('./src/lib/server/plugins')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const plugins = pluginsMod.default || pluginsMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      plugins.getPluginManager().registerBuiltin('test-ambiguous-connector-plugin', {
        name: 'Test Ambiguous Connector Plugin',
        connectors: [{
          id: 'test-voice',
          name: 'Test Voice',
          description: 'Test voice connector',
          startListener: async () => async () => {},
          sendMessage: async () => ({ messageId: 'should-not-send' }),
        }],
      })

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'anthropic',
          model: 'claude-test',
          plugins: ['manage_connectors'],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_voice: {
          id: 'conn_voice',
          name: 'Test Voice Connector',
          platform: 'test-voice',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      const voicePath = path.join(process.env.DATA_DIR, 'gran-voice.mp3')
      fs.writeFileSync(voicePath, Buffer.from('fake-mp3'))

      storage.saveSessions({
        session_1: {
          id: 'session_1',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'anthropic',
          model: 'claude-test',
          claudeSessionId: null,
          messages: [
            {
              role: 'user',
              text: 'Alice said hello',
              time: now - 1000,
              source: {
                platform: 'whatsapp',
                connectorId: 'conn_voice',
                connectorName: 'Test Voice Connector',
                channelId: '15550001111@s.whatsapp.net',
                senderId: '15550001111@s.whatsapp.net',
                senderName: 'Alice',
              },
            },
            {
              role: 'user',
              text: 'Gran replied after that',
              time: now,
              source: {
                platform: 'whatsapp',
                connectorId: 'conn_voice',
                connectorName: 'Test Voice Connector',
                channelId: '278200000001@s.whatsapp.net',
                senderId: '278200000001@s.whatsapp.net',
                senderName: 'Gran',
              },
            },
          ],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: ['manage_connectors'],
        },
      })

      await manager.startConnector('conn_voice')
      const built = await toolsApi.buildSessionTools(process.cwd(), ['manage_connectors'], {
        sessionId: 'session_1',
        agentId: 'agent_1',
        platformAssignScope: 'self',
      })

      try {
        const connectorTool = built.tools.find((tool) => tool.name === 'connector_message_tool')
        const raw = await connectorTool.invoke({
          action: 'send_voice_note',
          connectorId: 'conn_voice',
          mediaPath: voicePath,
        })
        console.log(JSON.stringify({ raw: String(raw) }))
      } finally {
        await built.cleanup()
        await manager.stopConnector('conn_voice')
      }
    `)

    assert.match(output.raw, /no target recipient configured/)
  })

  it('keeps direct connector sessions isolated across four inbound senders for the same agent and mirrors their metadata into the main thread', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            const text = String(opts.message || '')
            const match = text.match(/\\[(.*?)\\]/)
            const name = match?.[1] || 'Unknown'
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Replying to ' + name }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      const connector = storage.loadConnectors().conn_1
      const inbound = async (senderId, senderName, messageId, text) => manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: senderId,
        senderId,
        senderName,
        text,
        messageId,
        isGroup: false,
      })

      await inbound('15550001111@s.whatsapp.net', 'Alice', 'in-a', 'Hello from Alice')
      await inbound('16660002222@s.whatsapp.net', 'Bob', 'in-b', 'Hello from Bob')
      await inbound('278200000001@s.whatsapp.net', 'Gran', 'in-c', 'Hello from Gran')
      await inbound('447700900123@s.whatsapp.net', 'Wayde', 'in-d', 'Hello from Wayde')

      const sessions = storage.loadSessions()
      const directSessions = Object.values(sessions)
        .filter((entry) => String(entry.name || '').startsWith('connector:'))
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          senderName: entry.connectorContext?.senderName || null,
          channelId: entry.connectorContext?.channelId || null,
          texts: (entry.messages || []).map((m) => ({ role: m.role, text: m.text, source: m.source || null })),
        }))
        .sort((a, b) => String(a.senderName).localeCompare(String(b.senderName)))
      const thread = sessions.agent_thread
      console.log(JSON.stringify({ directSessions, threadMessages: thread.messages }))
    `)

    assert.equal(output.directSessions.length, 4)
    assert.deepEqual(output.directSessions.map((entry: any) => entry.senderName), ['Alice', 'Bob', 'Gran', 'Wayde'])
    assert.equal(output.directSessions.every((entry: any) => entry.texts.length === 2), true)
    assert.equal(output.directSessions.every((entry: any) => entry.texts[0].source?.senderName === entry.senderName), true)
    assert.equal(output.directSessions.every((entry: any) => entry.texts[1].text === `Replying to ${entry.senderName}`), true)
    assert.equal(output.threadMessages.length, 8)
    assert.deepEqual(
      output.threadMessages.filter((msg: any) => msg.role === 'user').map((msg: any) => msg.source?.senderName),
      ['Alice', 'Bob', 'Gran', 'Wayde'],
    )
    assert.deepEqual(
      output.threadMessages.filter((msg: any) => msg.role === 'assistant').map((msg: any) => ({
        text: msg.text,
        senderName: msg.source?.senderName,
        connectorId: msg.source?.connectorId,
      })),
      [
        { text: 'Replying to Alice', senderName: 'Alice', connectorId: 'conn_1' },
        { text: 'Replying to Bob', senderName: 'Bob', connectorId: 'conn_1' },
        { text: 'Replying to Gran', senderName: 'Gran', connectorId: 'conn_1' },
        { text: 'Replying to Wayde', senderName: 'Wayde', connectorId: 'conn_1' },
      ],
    )
    assert.equal(output.threadMessages.every((msg: any) => msg.historyExcluded === true), true)
  })

  it('excludes mirrored connector transcript entries from direct agent-thread history', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const chatExecMod = await import('@/lib/server/chat-execution/chat-execution')
      const streamChatMod = await import('@/lib/server/chat-execution/stream-agent-chat')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const chatExec = chatExecMod.default || chatExecMod
      const streamChat = streamChatMod.default || streamChatMod
      const providers = providersMod.default || providersMod
      const managerMod = await import('./src/lib/server/connectors/manager')
      const manager = managerMod.default || managerMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async () => '',
        },
      }
      streamChat.setStreamAgentChatForTest(async (opts) => ({
        fullText: JSON.stringify({
          historyCount: opts.history.length,
          texts: opts.history.map((entry) => entry.text),
          senderNames: opts.history.map((entry) => entry.source?.senderName || null),
        }),
        finalResponse: JSON.stringify({
          historyCount: opts.history.length,
          texts: opts.history.map((entry) => entry.text),
          senderNames: opts.history.map((entry) => entry.source?.senderName || null),
        }),
      }))

      try {
        storage.saveSettings({})
        storage.saveAgents({
          agent_1: {
            id: 'agent_1',
            name: 'Molly',
            provider: 'test-provider',
            model: 'test-model',
            plugins: [],
            threadSessionId: 'agent_thread',
            createdAt: now,
            updatedAt: now,
          },
        })
        storage.saveConnectors({
          conn_1: {
            id: 'conn_1',
            name: 'WhatsApp',
            platform: 'whatsapp',
            agentId: 'agent_1',
            credentialId: null,
            config: { inboundDebounceMs: 0 },
            isEnabled: true,
            status: 'running',
            createdAt: now,
            updatedAt: now,
          },
        })
        storage.saveSessions({
          agent_thread: {
            id: 'agent_thread',
            name: 'Molly',
            cwd: process.env.WORKSPACE_DIR,
            user: 'default',
            provider: 'test-provider',
            model: 'test-model',
            claudeSessionId: null,
            messages: [],
            createdAt: now,
            lastActiveAt: now,
            sessionType: 'human',
            agentId: 'agent_1',
            plugins: [],
          },
        })

        const connector = storage.loadConnectors().conn_1
        await manager.routeConnectorMessageForTest(connector, {
          platform: 'whatsapp',
          channelId: '15550001111@s.whatsapp.net',
          senderId: '15550001111@s.whatsapp.net',
          senderName: 'Alice',
          text: 'Hello from Alice',
          messageId: 'in-a',
          isGroup: false,
        })
        await manager.routeConnectorMessageForTest(connector, {
          platform: 'whatsapp',
          channelId: '278200000001@s.whatsapp.net',
          senderId: '278200000001@s.whatsapp.net',
          senderName: 'Gran',
          text: 'Hello from Gran',
          messageId: 'in-g',
          isGroup: false,
        })

        const result = await chatExec.executeSessionChatTurn({
          sessionId: 'agent_thread',
          message: 'This is Wayde in the app.',
        })

        const thread = storage.loadSessions().agent_thread
        const replyText = String(result.text || '').replace(/\\n+\\*-- Sent via Sample UI Plugin --\\*\\s*$/, '')
        console.log(JSON.stringify({
          reply: JSON.parse(replyText),
          threadMessages: thread.messages,
        }))
      } finally {
        streamChat.setStreamAgentChatForTest(null)
      }
    `)

    assert.equal(output.reply.senderNames.includes('Alice'), false)
    assert.equal(output.reply.senderNames.includes('Gran'), false)
    assert.equal(output.reply.texts.some((entry: any) => /Alice|Gran/.test(String(entry))), false)
    assert.equal(output.reply.historyCount >= 1, true)
    assert.equal(output.threadMessages.some((msg: any) => msg.historyExcluded === true && msg.source?.connectorId === 'conn_1'), true)
  })

  it('treats allowlist entries as the source of truth and does not create approval records for unknown senders', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod

      const now = Date.now()
      storage.saveSettings({ approvalsEnabled: true })
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: {
            inboundDebounceMs: 0,
            dmPolicy: 'allowlist',
            allowFrom: '15550001111',
          },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      const connector = storage.loadConnectors().conn_1
      const reply = await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '16660002222@s.whatsapp.net',
        senderId: '16660002222@s.whatsapp.net',
        senderName: 'Bob',
        text: 'Hello from Bob',
        messageId: 'in-b-allowlist',
        isGroup: false,
      })
      const approvals = Object.values(storage.loadApprovals())
      console.log(JSON.stringify({ reply, approvals }))
    `)

    assert.match(output.reply, /not approved for this connector/i)
    assert.match(output.reply, /no automatic approval queue is created/i)
    assert.equal(output.approvals.length, 0)
  })

  it('creates one reusable pairing request for unknown senders and allows them after approval', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const pairingMod = await import('./src/lib/server/connectors/pairing')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const pairing = pairingMod.default || pairingMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            const match = String(opts.message || '').match(/\\[(.*?)\\]/)
            const name = match?.[1] || 'Unknown'
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Approved hello to ' + name }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({ approvalsEnabled: true })
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: {
            inboundDebounceMs: 0,
            dmPolicy: 'pairing',
          },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      const connector = storage.loadConnectors().conn_1
      const inbound = async (messageId, text) => manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '16660002222@s.whatsapp.net',
        senderId: '16660002222@s.whatsapp.net',
        senderName: 'Bob',
        text,
        messageId,
        isGroup: false,
      })

      const first = await inbound('in-b1', 'Hello from Bob')
      const second = await inbound('in-b2', 'Following up before approval')
      const pendingBefore = pairing.listPendingPairingRequests('conn_1')
      const approved = pairing.approvePairingCode('conn_1', pendingBefore[0].code)
      const allowed = pairing.listStoredAllowedSenders('conn_1')
      const third = await inbound('in-b3', 'Hello after approval')
      const pendingAfter = pairing.listPendingPairingRequests('conn_1')
      const sessions = storage.loadSessions()
      const thread = sessions.agent_thread
      console.log(JSON.stringify({
        first,
        second,
        pendingBefore: pendingBefore.map((entry) => ({
          code: entry.code,
          senderId: entry.senderId,
          senderName: entry.senderName,
        })),
        approved,
        allowed,
        third,
        pendingAfter,
        threadMessages: thread.messages,
      }))
    `)

    assert.match(output.first, /pending pairing/i)
    assert.match(output.second, /pending pairing/i)
    assert.equal(output.pendingBefore.length, 1)
    assert.equal(output.pendingBefore[0].senderId, '16660002222@s.whatsapp.net')
    assert.equal(output.approved.ok, true)
    assert.deepEqual(output.allowed, ['16660002222@s.whatsapp.net'])
    assert.equal(output.third, 'Approved hello to Bob')
    assert.equal(output.pendingAfter.length, 0)
    assert.equal(output.threadMessages.some((msg: any) => msg.source?.senderName === 'Bob' && msg.historyExcluded === true), true)
  })

  it('allows WhatsApp senders listed in global settings without creating connector approvals', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Approved hello to Bob' }) + '\\n')
            return ''
          },
        },
      }

      storage.saveSettings({
        approvalsEnabled: true,
        whatsappApprovedContacts: [
          { id: 'family', label: 'Family', phone: '+16660002222' },
        ],
      })
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: [],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: {
            inboundDebounceMs: 0,
            dmPolicy: 'allowlist',
            allowFrom: '15550001111',
          },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
        },
      })

      const connector = storage.loadConnectors().conn_1
      const reply = await manager.routeConnectorMessageForTest(connector, {
        platform: 'whatsapp',
        channelId: '16660002222@s.whatsapp.net',
        senderId: '16660002222@s.whatsapp.net',
        senderName: 'Bob',
        text: 'Hello from approved settings contact',
        messageId: 'in-b-settings',
        isGroup: false,
      })
      const approvals = Object.values(storage.loadApprovals())
      const thread = storage.loadSessions().agent_thread
      console.log(JSON.stringify({
        reply,
        approvals,
        threadMessages: thread.messages,
      }))
    `)

    assert.equal(output.reply, 'Approved hello to Bob')
    assert.equal(output.approvals.length, 0)
    assert.equal(output.threadMessages.some((msg: any) => msg.source?.senderName === 'Bob' && msg.historyExcluded === true), true)
  })

  it('returns a friendly retry message instead of blank no-response when connector chat aborts', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const providers = providersMod.default || providersMod

      const now = Date.now()
      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async () => '',
        },
      }
      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          plugins: ['manage_connectors'],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'WhatsApp',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: { inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        agent_thread: {
          id: 'agent_thread',
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
          provider: 'test-provider',
          model: 'test-model',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: ['manage_connectors'],
        },
      })

      manager.setStreamAgentChatForTest(async (opts) => {
        opts.write('data: ' + JSON.stringify({ t: 'err', text: 'Abort' }) + '\\n')
        return {
          fullText: '',
          finalResponse: '',
          toolEvents: [],
        }
      })

      try {
        const connector = storage.loadConnectors().conn_1
        const response = await manager.routeConnectorMessageForTest(connector, {
          platform: 'whatsapp',
          channelId: '15550001111@s.whatsapp.net',
          senderId: '15550001111@s.whatsapp.net',
          senderName: 'Alice',
          text: 'Hello?',
          messageId: 'in-hello',
          isGroup: false,
        })
        const sessions = storage.loadSessions()
        const directSession = Object.values(sessions).find((entry) => String(entry.name || '').startsWith('connector:'))
        const mainSession = sessions.agent_thread
        console.log(JSON.stringify({ response, directSession, mainSession }))
      } finally {
        manager.setStreamAgentChatForTest(null)
      }
    `)

    assert.equal(output.response, 'Sorry, I hit a temporary issue while responding. Please try again.')
    assert.equal(output.directSession.messages.at(-1).role, 'assistant')
    assert.equal(output.directSession.messages.at(-1).text, 'Sorry, I hit a temporary issue while responding. Please try again.')
    assert.equal(output.mainSession.messages.at(-1).historyExcluded, true)
    assert.equal(output.mainSession.messages.at(-1).text, 'Sorry, I hit a temporary issue while responding. Please try again.')
  })
})
