import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '../test-utils/run-with-temp-data-dir'

describe('connector outbox', () => {
  it('delivers scheduled follow-ups through the durable outbox worker', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const outboxMod = await import('./src/lib/server/connectors/outbox')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const outbox = outboxMod.default || outboxMod
      const plugins = pluginsMod.default || pluginsMod

      const attempts = []
      plugins.getPluginManager().registerBuiltin('test-outbox-plugin', {
        name: 'Test Outbox Plugin',
        connectors: [{
          id: 'test-outbox',
          name: 'Test Outbox',
          description: 'Test connector for outbox delivery',
          startListener: async () => async () => {},
          sendMessage: async (channelId, text) => {
            attempts.push({ channelId, text })
            return { messageId: 'outbox-msg-1' }
          },
        }],
      })

      const now = Date.now()
      storage.saveSettings({})
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'Outbox Connector',
          platform: 'test-outbox',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      await manager.startConnector('conn_1')
      const scheduled = manager.scheduleConnectorFollowUp({
        connectorId: 'conn_1',
        channelId: '15550001111',
        text: 'Follow up later',
        delaySec: 1,
      })
      const before = storage.loadConnectorOutbox()[scheduled.followUpId]
      await outbox.runConnectorOutboxNow({ now: scheduled.sendAt + 5 })
      const after = storage.loadConnectorOutbox()[scheduled.followUpId]
      console.log(JSON.stringify({ scheduled, before, after, attempts }))
    `, { prefix: 'swarmclaw-outbox-test-' })

    assert.equal(output.before.status, 'pending')
    assert.equal(output.after.status, 'sent')
    assert.equal(output.after.lastMessageId, 'outbox-msg-1')
    assert.deepEqual(output.attempts, [{ channelId: '15550001111', text: 'Follow up later' }])
  })

  it('retries failed outbox sends with backoff and eventually marks them sent', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const outboxMod = await import('./src/lib/server/connectors/outbox')
      const pluginsMod = await import('./src/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const outbox = outboxMod.default || outboxMod
      const plugins = pluginsMod.default || pluginsMod

      let sendCount = 0
      plugins.getPluginManager().registerBuiltin('test-outbox-retry-plugin', {
        name: 'Test Outbox Retry Plugin',
        connectors: [{
          id: 'test-outbox-retry',
          name: 'Test Outbox Retry',
          description: 'Test connector for outbox retries',
          startListener: async () => async () => {},
          sendMessage: async (channelId, text) => {
            sendCount += 1
            if (sendCount === 1) throw new Error('temporary send failure')
            return { messageId: 'retry-msg-2' }
          },
        }],
      })

      const now = Date.now()
      storage.saveSettings({})
      storage.saveConnectors({
        conn_retry: {
          id: 'conn_retry',
          name: 'Retry Connector',
          platform: 'test-outbox-retry',
          agentId: 'agent_1',
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      await manager.startConnector('conn_retry')
      const queued = outbox.enqueueConnectorOutbox({
        connectorId: 'conn_retry',
        channelId: 'retry-channel',
        text: 'Retry me',
        sendAt: now,
        maxAttempts: 3,
      })
      await outbox.runConnectorOutboxNow({ now: queued.sendAt + 1 })
      const afterFirst = storage.loadConnectorOutbox()[queued.outboxId]
      await outbox.runConnectorOutboxNow({ now: afterFirst.sendAt + 1 })
      const afterSecond = storage.loadConnectorOutbox()[queued.outboxId]
      console.log(JSON.stringify({ afterFirst, afterSecond, sendCount }))
    `, { prefix: 'swarmclaw-outbox-test-' })

    assert.equal(output.afterFirst.status, 'pending')
    assert.equal(output.afterFirst.attemptCount, 1)
    assert.match(output.afterFirst.lastError, /temporary send failure/i)
    assert.equal(output.afterSecond.status, 'sent')
    assert.equal(output.afterSecond.attemptCount, 2)
    assert.equal(output.afterSecond.lastMessageId, 'retry-msg-2')
    assert.equal(output.sendCount, 2)
  })

  it('dedupes and replaces scheduled follow-ups durably', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const managerMod = await import('./src/lib/server/connectors/manager')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod

      const now = Date.now()
      storage.saveSettings({})
      storage.saveConnectors({
        conn_1: {
          id: 'conn_1',
          name: 'Outbox Connector',
          platform: 'whatsapp',
          agentId: 'agent_1',
          credentialId: null,
          config: {},
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      const first = manager.scheduleConnectorFollowUp({
        connectorId: 'conn_1',
        channelId: '15550001111@s.whatsapp.net',
        text: 'First follow-up',
        delaySec: 30,
        dedupeKey: 'dup-1',
      })
      const second = manager.scheduleConnectorFollowUp({
        connectorId: 'conn_1',
        channelId: '15550001111@s.whatsapp.net',
        text: 'Second follow-up same dedupe',
        delaySec: 30,
        dedupeKey: 'dup-1',
      })
      const third = manager.scheduleConnectorFollowUp({
        connectorId: 'conn_1',
        channelId: '15550001111@s.whatsapp.net',
        text: 'Replacement follow-up',
        delaySec: 30,
        dedupeKey: 'dup-1',
        replaceExisting: true,
      })
      const outbox = storage.loadConnectorOutbox()
      console.log(JSON.stringify({ first, second, third, outbox }))
    `, { prefix: 'swarmclaw-outbox-test-' })

    assert.equal(output.first.followUpId, output.second.followUpId)
    assert.notEqual(output.third.followUpId, output.first.followUpId)
    assert.equal(output.outbox[output.first.followUpId].status, 'cancelled')
    assert.equal(output.outbox[output.third.followUpId].status, 'pending')
    assert.equal(output.outbox[output.third.followUpId].text, 'Replacement follow-up')
  })
})
