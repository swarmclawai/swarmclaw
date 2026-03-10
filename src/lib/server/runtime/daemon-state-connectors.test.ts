import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

describe('connector lifecycle for daemon recovery', () => {
  it('preserves enabled connectors across runtime stop/start and auto-starts them again', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const managerMod = await import('@/lib/server/connectors/manager')
      const pluginsMod = await import('@/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const plugins = pluginsMod.default || pluginsMod

      let startCount = 0
      plugins.getPluginManager().registerBuiltin('test-daemon-autostart-plugin', {
        name: 'Test Daemon Autostart Plugin',
        connectors: [{
          id: 'test-daemon-autostart',
          name: 'Test Daemon Autostart',
          description: 'Connector started by runtime autostart',
          startListener: async () => {
            startCount += 1
            return async () => {}
          },
        }],
      })

      const now = Date.now()
      storage.saveSettings({})
      storage.saveConnectors({
        conn_auto: {
          id: 'conn_auto',
          name: 'Autostart Connector',
          platform: 'test-daemon-autostart',
          agentId: null,
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        },
      })

      await manager.startConnector('conn_auto')
      const firstStart = {
        running: manager.listRunningConnectors(),
        connector: storage.loadConnectors().conn_auto,
      }

      await manager.stopAllConnectors({ disable: false })
      const afterStop = storage.loadConnectors().conn_auto

      await manager.autoStartConnectors()
      const secondStart = {
        running: manager.listRunningConnectors(),
        connector: storage.loadConnectors().conn_auto,
      }

      await manager.stopAllConnectors()

      console.log(JSON.stringify({
        startCount,
        firstStart,
        afterStop,
        secondStart,
      }))
    `, { prefix: 'swarmclaw-daemon-test-' })

    assert.equal(output.startCount, 2)
    assert.equal(output.firstStart.running.some((entry: { id: string }) => entry.id === 'conn_auto'), true)
    assert.equal(output.firstStart.connector.status, 'running')
    assert.equal(output.afterStop.isEnabled, true)
    assert.equal(output.afterStop.status, 'stopped')
    assert.equal(output.secondStart.running.some((entry: { id: string }) => entry.id === 'conn_auto'), true)
    assert.equal(output.secondStart.connector.status, 'running')
  })

  it('restarts unhealthy connectors through the daemon recovery path', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const managerMod = await import('@/lib/server/connectors/manager')
      const pluginsMod = await import('@/lib/server/plugins')
      const storage = storageMod.default || storageMod
      const manager = managerMod.default || managerMod
      const plugins = pluginsMod.default || pluginsMod

      let startCount = 0
      let stopCount = 0
      plugins.getPluginManager().registerBuiltin('test-daemon-restart-plugin', {
        name: 'Test Daemon Restart Plugin',
        connectors: [{
          id: 'test-daemon-restart',
          name: 'Test Daemon Restart',
          description: 'Connector restarted by daemon-style recovery',
          startListener: async () => {
            startCount += 1
            return async () => {}
          },
        }],
      })

      const now = Date.now()
      storage.saveSettings({})
      storage.saveConnectors({
        conn_restart: {
          id: 'conn_restart',
          name: 'Restart Connector',
          platform: 'test-daemon-restart',
          agentId: null,
          credentialId: null,
          config: { botToken: 'test-token' },
          isEnabled: true,
          status: 'running',
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      const running = globalThis.__swarmclaw_running_connectors__ || new Map()
      globalThis.__swarmclaw_running_connectors__ = running
      running.set('conn_restart', {
        connector: storage.loadConnectors().conn_restart,
        authenticated: true,
        isAlive: () => false,
        stop: async () => {
          stopCount += 1
        },
      })

      await manager.checkConnectorHealth()
      const reconnectState = manager.getReconnectState('conn_restart')
      if (reconnectState && !reconnectState.exhausted) {
        await manager.startConnector('conn_restart')
        manager.clearReconnectState('conn_restart')
      }

      const health = Object.values(storage.loadConnectorHealth())
        .filter((entry) => entry.connectorId === 'conn_restart')
        .map((entry) => entry.event)

      console.log(JSON.stringify({
        startCount,
        stopCount,
        status: manager.getConnectorStatus('conn_restart'),
        reconnectState: manager.getReconnectState('conn_restart'),
        connector: storage.loadConnectors().conn_restart,
        health,
        running: manager.listRunningConnectors(),
      }))

      await manager.stopAllConnectors()
    `, { prefix: 'swarmclaw-daemon-test-' })

    assert.equal(output.startCount, 1)
    assert.equal(output.stopCount, 1)
    assert.equal(output.status, 'running')
    assert.equal(output.reconnectState, null)
    assert.equal(output.connector.status, 'running')
    assert.equal(output.connector.lastError, null)
    assert.equal(output.health.includes('disconnected'), true)
    assert.equal(output.health.includes('started'), true)
    assert.equal(output.running.some((entry: { id: string }) => entry.id === 'conn_restart'), true)
  })
})
