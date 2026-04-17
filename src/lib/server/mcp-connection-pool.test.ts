import assert from 'node:assert/strict'
import { describe, it, beforeEach, after } from 'node:test'
import type { McpServerConfig } from '@/types'
import {
  __setPoolConnector,
  evictAllMcpClients,
  evictMcpClient,
  getOrConnectMcpClient,
  isPooled,
  poolSize,
} from './mcp-connection-pool'

let connectCalls = 0
let disconnectCalls = 0

function server(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: `srv-${id}`,
    transport: 'stdio',
    command: 'echo',
    args: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('mcp-connection-pool', () => {
  beforeEach(async () => {
    await evictAllMcpClients()
    connectCalls = 0
    disconnectCalls = 0
    __setPoolConnector({
      connect: async () => {
        connectCalls += 1
        return {
          client: { seq: connectCalls } as never,
          transport: { seq: connectCalls } as never,
        }
      },
      disconnect: async () => {
        disconnectCalls += 1
      },
    })
  })

  after(() => {
    __setPoolConnector()
  })

  it('connects once per server and reuses on subsequent calls', async () => {
    const a = await getOrConnectMcpClient(server('a'))
    const b = await getOrConnectMcpClient(server('a'))
    assert.equal(connectCalls, 1)
    assert.equal(a.client, b.client)
  })

  it('reconnects when the config fingerprint changes', async () => {
    await getOrConnectMcpClient(server('a', { args: ['--v1'] }))
    await getOrConnectMcpClient(server('a', { args: ['--v2'] }))
    assert.equal(connectCalls, 2)
    assert.equal(disconnectCalls, 1)
  })

  it('evictMcpClient disconnects and lets the next call reconnect', async () => {
    await getOrConnectMcpClient(server('a'))
    await evictMcpClient('a')
    assert.equal(disconnectCalls, 1)
    assert.equal(isPooled('a'), false)
    await getOrConnectMcpClient(server('a'))
    assert.equal(connectCalls, 2)
  })

  it('coalesces concurrent connects', async () => {
    const [a, b] = await Promise.all([
      getOrConnectMcpClient(server('dup')),
      getOrConnectMcpClient(server('dup')),
    ])
    assert.equal(connectCalls, 1)
    assert.equal(a.client, b.client)
  })

  it('tracks multiple distinct servers independently', async () => {
    await getOrConnectMcpClient(server('a'))
    await getOrConnectMcpClient(server('b'))
    assert.equal(poolSize(), 2)
    assert.equal(connectCalls, 2)
  })

  it('evictAll clears everything', async () => {
    await getOrConnectMcpClient(server('a'))
    await getOrConnectMcpClient(server('b'))
    await evictAllMcpClients()
    assert.equal(disconnectCalls, 2)
    assert.equal(poolSize(), 0)
  })
})
