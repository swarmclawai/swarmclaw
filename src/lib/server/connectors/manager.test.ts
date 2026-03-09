import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { sanitizeConnectorOutboundContent } from './manager'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-manager-test-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
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
      const heartbeatMod = await import('./src/lib/server/heartbeat-wake')
      const systemEventsMod = await import('./src/lib/server/system-events')
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
          name: 'Molly',
          cwd: process.env.WORKSPACE_DIR,
          user: 'default',
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

  it('blocks ambiguous connector sends when a thread references multiple people on the same connector', () => {
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

    assert.match(output.raw, /multiple connector recipients/)
    assert.match(output.raw, /Alice/)
    assert.match(output.raw, /Gran/)
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
      const managerMod = await import('./src/lib/server/connectors/manager')
      const chatExecMod = await import('./src/lib/server/chat-execution')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const chatExec = chatExecMod.default || chatExecMod
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
            const history = typeof opts.loadHistory === 'function' ? opts.loadHistory(opts.session.id) : []
            return JSON.stringify({
              historyCount: history.length,
              texts: history.map((entry) => entry.text),
              senderNames: history.map((entry) => entry.source?.senderName || null),
            })
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
      console.log(JSON.stringify({
        reply: JSON.parse(result.text),
        threadMessages: thread.messages,
      }))
    `)

    assert.equal(output.reply.senderNames.includes('Alice'), false)
    assert.equal(output.reply.senderNames.includes('Gran'), false)
    assert.equal(output.reply.texts.some((entry: any) => /Alice|Gran/.test(String(entry))), false)
    assert.equal(output.reply.historyCount >= 1, true)
    assert.equal(output.threadMessages.some((msg: any) => msg.historyExcluded === true && msg.source?.connectorId === 'conn_1'), true)
  })

  it('creates one reusable connector-sender approval for unknown allowlist senders and allows them after approval', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const approvalsMod = await import('./src/lib/server/approvals')
      const pairingMod = await import('./src/lib/server/connectors/pairing')
      const providersMod = await import('./src/lib/providers/index')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const approvals = approvalsMod.default || approvalsMod
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
      const pendingBefore = Object.values(storage.loadApprovals())
      await approvals.submitDecision(pendingBefore[0].id, true)
      const allowed = pairing.listStoredAllowedSenders('conn_1')
      const third = await inbound('in-b3', 'Hello after approval')
      const approvalsAfter = Object.values(storage.loadApprovals())
      const sessions = storage.loadSessions()
      const thread = sessions.agent_thread
      console.log(JSON.stringify({
        first,
        second,
        pendingBefore: pendingBefore.map((entry) => ({
          id: entry.id,
          category: entry.category,
          status: entry.status,
          title: entry.title,
          data: entry.data,
        })),
        allowed,
        third,
        approvalsAfter: approvalsAfter.map((entry) => ({ id: entry.id, status: entry.status })),
        threadMessages: thread.messages,
      }))
    `)

    assert.match(output.first, /pending approval/i)
    assert.match(output.second, /pending approval/i)
    assert.equal(output.pendingBefore.length, 1)
    assert.equal(output.pendingBefore[0].category, 'connector_sender')
    assert.equal(output.pendingBefore[0].data.senderId, '16660002222@s.whatsapp.net')
    assert.deepEqual(output.allowed, ['16660002222@s.whatsapp.net'])
    assert.equal(output.third, 'Approved hello to Bob')
    assert.equal(output.approvalsAfter.length, 1)
    assert.equal(output.approvalsAfter[0].status, 'approved')
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
