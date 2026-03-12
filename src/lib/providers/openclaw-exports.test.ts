import assert from 'node:assert/strict'
import { test } from 'node:test'

// Verify that rpcOnConnectedGateway is exported (needed by setup check-provider route)
test('rpcOnConnectedGateway is exported from openclaw provider', async () => {
  const mod = await import('./openclaw')
  assert.equal(typeof mod.rpcOnConnectedGateway, 'function')
})

test('wsConnect is exported from openclaw provider', async () => {
  const mod = await import('./openclaw')
  assert.equal(typeof mod.wsConnect, 'function')
})

test('getDeviceId is exported from openclaw provider', async () => {
  const mod = await import('./openclaw')
  assert.equal(typeof mod.getDeviceId, 'function')
})

test('buildOpenClawConnectParams is exported from openclaw provider', async () => {
  const mod = await import('./openclaw')
  assert.equal(typeof mod.buildOpenClawConnectParams, 'function')
})
