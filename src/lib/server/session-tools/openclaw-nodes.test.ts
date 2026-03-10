import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeNodesAction } from './openclaw-nodes'
import type { OpenClawGateway } from '../openclaw/gateway'

test('executeNodesAction returns not_connected when no gateway is available', async () => {
  const raw = await executeNodesAction(
    { action: 'list', profileId: 'gateway-1' },
    { ensureGatewayConnected: async () => null },
  )
  const result = JSON.parse(raw)
  assert.equal(result.status, 'not_connected')
  assert.match(result.message, /gateway not connected/i)
})

test('executeNodesAction lists nodes against the selected gateway profile', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const gateway = {
    rpc: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return { ts: 1, nodes: [{ nodeId: 'node-1' }] }
    },
  }

  const raw = await executeNodesAction(
    { action: 'list', profileId: 'gateway-1' },
    { ensureGatewayConnected: async () => gateway as unknown as OpenClawGateway },
  )
  const result = JSON.parse(raw)
  assert.equal(result.status, 'ok')
  assert.equal(calls[0]?.method, 'node.list')
  assert.deepEqual(calls[0]?.params, { profileId: 'gateway-1' })
  assert.equal(result.result.nodes[0].nodeId, 'node-1')
})

test('executeNodesAction aggregates node and device pairings', async () => {
  const calls: string[] = []
  const gateway = {
    rpc: async (method: string) => {
      calls.push(method)
      if (method === 'node.pair.list') return { pending: [{ requestId: 'node-req-1' }] }
      if (method === 'device.pair.list') return { pending: [{ requestId: 'device-req-1' }], paired: [{ deviceId: 'device-1' }] }
      throw new Error(`Unexpected RPC ${method}`)
    },
  }

  const raw = await executeNodesAction(
    { action: 'pairings', profileId: 'gateway-1' },
    { ensureGatewayConnected: async () => gateway as unknown as OpenClawGateway },
  )
  const result = JSON.parse(raw)
  assert.equal(result.status, 'ok')
  assert.deepEqual(calls, ['node.pair.list', 'device.pair.list'])
  assert.equal(result.result.nodePairings.pending[0].requestId, 'node-req-1')
  assert.equal(result.result.devicePairings.paired[0].deviceId, 'device-1')
})

test('executeNodesAction routes device pairing approvals to the device RPC surface', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const gateway = {
    rpc: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return { ok: true }
    },
  }

  const raw = await executeNodesAction(
    { action: 'approve_pairing', pairingType: 'device', requestId: 'req-1', profileId: 'gateway-1' },
    { ensureGatewayConnected: async () => gateway as unknown as OpenClawGateway },
  )
  const result = JSON.parse(raw)
  assert.equal(result.status, 'ok')
  assert.equal(calls[0]?.method, 'device.pair.approve')
  assert.deepEqual(calls[0]?.params, { requestId: 'req-1', profileId: 'gateway-1' })
})

test('executeNodesAction forwards notify payloads through node.invoke with a generated idempotency key', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const gateway = {
    rpc: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return { delivered: true }
    },
  }

  const raw = await executeNodesAction(
    {
      action: 'notify',
      profileId: 'gateway-1',
      nodeId: 'node-42',
      message: 'hello from test',
      params: { urgency: 'high' },
      timeoutMs: 5000,
    },
    {
      ensureGatewayConnected: async () => gateway as unknown as OpenClawGateway,
      generateId: () => 'fixed-id',
    },
  )
  const result = JSON.parse(raw)
  assert.equal(result.status, 'ok')
  assert.equal(calls[0]?.method, 'node.invoke')
  assert.deepEqual(calls[0]?.params, {
    nodeId: 'node-42',
    command: 'notify',
    params: { urgency: 'high', message: 'hello from test' },
    timeoutMs: 5000,
    idempotencyKey: 'fixed-id',
    profileId: 'gateway-1',
  })
})
