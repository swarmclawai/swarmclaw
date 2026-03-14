import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '../test-utils/run-with-temp-data-dir'

describe('connector manager roundtrip routing', () => {
  it('routes inbound connector messages through a running connector and sends the reply back out', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const connectorTypesMod = await import('./src/lib/server/connectors/types')
      const providersMod = await import('./src/lib/providers/index')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const connectorTypes = connectorTypesMod.default || connectorTypesMod
      const providers = providersMod.default || providersMod
      const plugins = pluginsMod.default || pluginsMod

      const now = Date.now()
      const sent = []
      let inboundHandler

      providers.PROVIDERS['test-provider'] = {
        id: 'test-provider',
        name: 'Test Provider',
        models: ['test-model'],
        requiresApiKey: false,
        requiresEndpoint: false,
        handler: {
          streamChat: async (opts) => {
            opts.write('data: ' + JSON.stringify({ t: 'r', text: 'Reply over connector' }) + '\\n')
            return ''
          },
        },
      }

      plugins.getPluginManager().registerBuiltin('test-bidi-connector-plugin', {
        name: 'Test Bidi Connector Plugin',
        connectors: [{
          id: 'test-bidi',
          name: 'Test Bidi',
          description: 'Connector that records inbound and outbound traffic',
          startListener: async (onMessage) => {
            inboundHandler = async (message) => {
              const routeResult = connectorTypes.normalizeConnectorIngressResult(await onMessage(message))
              if (routeResult.managerHandled !== true && routeResult.delivery !== 'silent' && routeResult.visibleText !== 'NO_MESSAGE') {
                sent.push({ channelId: message.channelId, text: routeResult.visibleText })
                return {
                  ...routeResult,
                  delivery: 'sent',
                  messageId: 'bidi-out-1',
                }
              }
              return routeResult
            }
            return async () => {}
          },
          sendMessage: async (channelId, text) => {
            sent.push({ channelId, text })
            return { messageId: 'bidi-out-1' }
          },
        }],
      })

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
          name: 'Roundtrip Connector',
          platform: 'test-bidi',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token', inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'stopped',
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

      await manager.startConnector('conn_1')

      try {
        const routeResult = await inboundHandler({
          platform: 'test-bidi',
          channelId: 'connector-channel',
          senderId: 'connector-user',
          senderName: 'Alice',
          text: 'Hello from connector',
          messageId: 'in-bidi-1',
          isGroup: false,
        })

        const sessions = storage.loadSessions()
        const directSession = Object.values(sessions).find((entry) => String(entry.name || '').startsWith('connector:'))
        const mainSession = sessions.agent_thread
        console.log(JSON.stringify({ routeResult, sent, directSession, mainSession }))
      } finally {
        await manager.stopConnector('conn_1')
      }
    `, { prefix: 'swarmclaw-manager-roundtrip-test-' })

    assert.deepEqual(output.sent, [{ channelId: 'connector-channel', text: 'Reply over connector' }])
    assert.equal(output.routeResult.messageId, 'bidi-out-1')
    assert.equal(output.directSession.messages.length, 2)
    assert.equal(output.directSession.messages[0].source.messageId, 'in-bidi-1')
    assert.equal(output.directSession.messages[1].text, 'Reply over connector')
    assert.equal(output.mainSession.messages.length, 0)
  })

  it('does not emit a second transport reply when same-channel connector delivery was already reported', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const connectorTypesMod = await import('./src/lib/server/connectors/types')
      const providersMod = await import('./src/lib/providers/index')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const connectorTypes = connectorTypesMod.default || connectorTypesMod
      const providers = providersMod.default || providersMod
      const plugins = pluginsMod.default || pluginsMod

      const now = Date.now()
      const sent = []
      let inboundHandler

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

      plugins.getPluginManager().registerBuiltin('test-bidi-connector-plugin-dedupe', {
        name: 'Test Bidi Connector Plugin Dedupe',
        connectors: [{
          id: 'test-bidi-dedupe',
          name: 'Test Bidi Dedupe',
          description: 'Connector that records outbound sends for duplicate suppression tests',
          startListener: async (onMessage) => {
            inboundHandler = async (message) => {
              const routeResult = connectorTypes.normalizeConnectorIngressResult(await onMessage(message))
              if (routeResult.managerHandled !== true && routeResult.delivery !== 'silent' && routeResult.visibleText !== 'NO_MESSAGE') {
                sent.push({ channelId: message.channelId, text: routeResult.visibleText, path: 'adapter' })
                return {
                  ...routeResult,
                  delivery: 'sent',
                  messageId: 'adapter-out-1',
                }
              }
              return routeResult
            }
            return async () => {}
          },
          sendMessage: async (channelId, text) => {
            sent.push({ channelId, text, path: 'tool' })
            return { messageId: 'tool-out-1' }
          },
        }],
      })

      storage.saveSettings({})
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          provider: 'test-provider',
          model: 'test-model',
          tools: ['connector_message_tool'],
          plugins: ['connector_message_tool'],
          threadSessionId: 'agent_thread',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'Roundtrip Connector',
          platform: 'test-bidi-dedupe',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token', inboundDebounceMs: 0 },
          isEnabled: true,
          status: 'stopped',
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
          tools: ['connector_message_tool'],
          plugins: ['connector_message_tool'],
        },
      })

      manager.setStreamAgentChatForTest(async (opts) => {
        opts.write('data: ' + JSON.stringify({
          t: 'tool_call',
          toolName: 'connector_message_tool',
          toolInput: JSON.stringify({
            action: 'send',
            to: 'connector-channel',
            message: 'Delivered by tool',
          }),
          toolCallId: 'call-1',
        }) + '\\n')
        opts.write('data: ' + JSON.stringify({
          t: 'tool_result',
          toolName: 'connector_message_tool',
          toolOutput: JSON.stringify({
            status: 'sent',
            to: 'connector-channel',
            messageId: 'tool-out-1',
          }),
          toolCallId: 'call-1',
        }) + '\\n')
        return {
          fullText: 'I sent that update through the connector.',
          finalResponse: 'I sent that update through the connector.',
          toolEvents: [],
        }
      })

      await manager.startConnector('conn_1')

      try {
        const routeResult = await inboundHandler({
          platform: 'test-bidi-dedupe',
          channelId: 'connector-channel',
          senderId: 'connector-user',
          senderName: 'Alice',
          text: 'Please send the update.',
          messageId: 'in-bidi-2',
          isGroup: false,
        })

        const sessions = storage.loadSessions()
        const directSession = Object.values(sessions).find((entry) => String(entry.name || '').startsWith('connector:'))
        console.log(JSON.stringify({ routeResult, sent, directSession }))
      } finally {
        manager.setStreamAgentChatForTest(null)
        await manager.stopConnector('conn_1')
      }
    `, { prefix: 'swarmclaw-manager-roundtrip-dup-' })

    assert.deepEqual(output.sent, [])
    assert.equal(output.routeResult.delivery, 'silent')
    assert.equal(output.routeResult.visibleText, 'NO_MESSAGE')
    assert.equal(output.directSession.messages.length, 2)
    assert.equal(output.directSession.messages[1].kind, 'connector-delivery')
    assert.equal(output.directSession.messages[1].historyExcluded, true)
    assert.equal(output.directSession.messages[1].text, 'Message delivered.')
    assert.equal(output.directSession.messages[1].source.messageId, 'tool-out-1')
    assert.equal(output.directSession.messages[1].source.deliveryMode, 'text')
    assert.equal(output.directSession.messages[1].source.deliveryTranscript, 'Delivered by tool')
    assert.equal(output.directSession.messages[1].source.replyToMessageId, 'in-bidi-2')
  })
})
