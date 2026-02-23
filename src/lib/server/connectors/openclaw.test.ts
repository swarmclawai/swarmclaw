import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import openclaw from './openclaw.ts'

type WsFrame = Record<string, unknown>

type MockEventHandler<T> = ((event: T) => void) | null

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: MockWebSocket[] = []

  static reset() {
    this.instances = []
  }

  readonly url: string
  readyState = MockWebSocket.CONNECTING
  sent: WsFrame[] = []

  onopen: (() => void) | null = null
  onmessage: MockEventHandler<{ data: string }> = null
  onclose: MockEventHandler<{ code: number; reason: string }> = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN
        this.onopen?.()
      }
    }, 0)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as WsFrame)
  }

  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }

  emit(frame: WsFrame) {
    if (this.readyState !== MockWebSocket.OPEN) return
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function findReq(ws: MockWebSocket, method: string): WsFrame | undefined {
  return ws.sent.find((frame) => frame?.type === 'req' && frame?.method === method)
}

function findReqAt(ws: MockWebSocket, method: string, index: number): WsFrame | undefined {
  const matches = ws.sent.filter((frame) => frame?.type === 'req' && frame?.method === method)
  return matches[index]
}

async function waitFor<T>(
  getValue: () => T | null | undefined,
  timeoutMs = 2_000,
  pollMs = 10,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    const value = getValue()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

async function bootstrapConnector(params?: {
  onMessage?: (msg: any) => Promise<string>
  connectorId?: string
  wsUrl?: string
  config?: Record<string, unknown>
}) {
  const connectorId = params?.connectorId || `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const connector = {
    id: connectorId,
    name: 'OpenClaw Test',
    platform: 'openclaw',
    agentId: 'agent-test',
    credentialId: null,
    config: {
      wsUrl: params?.wsUrl || 'ws://localhost:18789',
      historyPoll: false,
      ...(params?.config || {}),
    },
    isEnabled: true,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any

  const onMessage = params?.onMessage || (async () => 'ok')
  const instance = await openclaw.start(connector, '', onMessage)
  const ws = await waitFor(() => MockWebSocket.instances[0], 1_500)
  const identityPath = path.join(process.cwd(), 'data', 'openclaw', `${connectorId}-device.json`)
  return { instance, ws, identityPath }
}

async function performHandshake(ws: MockWebSocket, helloPayload?: WsFrame) {
  ws.emit({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } })
  const connectReq = await waitFor(() => findReq(ws, 'connect'), 1_500)
  ws.emit({
    type: 'res',
    id: connectReq.id as string,
    ok: true,
    payload: helloPayload || {
      type: 'hello-ok',
      protocol: 3,
      auth: { deviceToken: 'device-token-test' },
      policy: { tickIntervalMs: 15_000 },
    },
  })
}

const originalWebSocket = (globalThis as any).WebSocket

test.beforeEach(() => {
  MockWebSocket.reset()
  ;(globalThis as any).WebSocket = MockWebSocket
})

test.afterEach(() => {
  ;(globalThis as any).WebSocket = originalWebSocket
})

test('openclaw connector performs connect handshake and routes inbound chat', async () => {
  const received: any[] = []
  const { instance, ws, identityPath } = await bootstrapConnector({
    onMessage: async (msg) => {
      received.push(msg)
      return 'pong'
    },
  })

  try {
    await performHandshake(ws)
    ws.emit({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        sessionKey: 'main',
        message: { role: 'user', text: 'Hello there', sender: 'Wayde' },
      },
    })

    const chatReq = await waitFor(() => findReq(ws, 'chat.send'), 2_000)
    assert.equal(chatReq.params && (chatReq.params as any).message, 'pong')
    assert.equal(chatReq.params && (chatReq.params as any).sessionKey, 'main')
    assert.equal(received.length, 1)
    assert.equal(received[0].text, 'Hello there')

    ws.emit({ type: 'res', id: chatReq.id as string, ok: true, payload: { runId: 'run-1' } })
  } finally {
    await instance.stop()
    fs.rmSync(identityPath, { force: true })
  }
})

test('openclaw connector suppresses outbound send when NO_MESSAGE is returned', async () => {
  const { instance, ws, identityPath } = await bootstrapConnector({
    onMessage: async () => 'NO_MESSAGE',
  })

  try {
    await performHandshake(ws)
    ws.emit({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        sessionKey: 'main',
        message: { role: 'user', text: 'ack', sender: 'Wayde' },
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 80))
    const sends = ws.sent.filter((frame) => frame.type === 'req' && frame.method === 'chat.send')
    assert.equal(sends.length, 0)
  } finally {
    await instance.stop()
    fs.rmSync(identityPath, { force: true })
  }
})

test('openclaw connector accepts short session filter for full agent session keys', async () => {
  const received: any[] = []
  const { instance, ws, identityPath } = await bootstrapConnector({
    onMessage: async (msg) => {
      received.push(msg)
      return 'alias-ok'
    },
    config: {
      sessionKey: 'main',
    },
  })

  try {
    await performHandshake(ws)
    ws.emit({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        sessionKey: 'agent:main:main',
        message: { role: 'user', text: 'Hello alias', sender: 'Wayde' },
      },
    })

    const chatReq = await waitFor(() => findReq(ws, 'chat.send'), 2_000)
    assert.equal((chatReq.params as any)?.sessionKey, 'agent:main:main')
    assert.equal((chatReq.params as any)?.message, 'alias-ok')
    assert.equal(received.length, 1)
    assert.equal(received[0]?.text, 'Hello alias')

    ws.emit({
      type: 'res',
      id: chatReq.id as string,
      ok: true,
      payload: { runId: 'alias-run' },
    })
  } finally {
    await instance.stop()
    fs.rmSync(identityPath, { force: true })
  }
})

test('openclaw connector sendMessage attaches local media payloads', async () => {
  const { instance, ws, identityPath } = await bootstrapConnector()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-connector-test-'))
  const localPath = path.join(tmpDir, 'note.txt')
  fs.writeFileSync(localPath, 'hello attachment', 'utf8')

  try {
    await performHandshake(ws)
    const sendPromise = instance.sendMessage?.('main', '', {
      mediaPath: localPath,
      fileName: 'note.txt',
      mimeType: 'text/plain',
    })

    const chatReq = await waitFor(() => findReq(ws, 'chat.send'), 2_000)
    const params = (chatReq.params || {}) as any
    assert.equal(params.message, 'See attached.')
    assert.ok(Array.isArray(params.attachments))
    assert.equal(params.attachments.length, 1)
    assert.equal(params.attachments[0].mimeType, 'text/plain')
    assert.equal(params.attachments[0].type, 'file')
    assert.equal(params.attachments[0].content, Buffer.from('hello attachment').toString('base64'))

    ws.emit({ type: 'res', id: chatReq.id as string, ok: true, payload: { runId: 'run-media' } })
    await sendPromise
  } finally {
    await instance.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(identityPath, { force: true })
  }
})

test('openclaw connector polls chat.history fallback for inbound user messages', async () => {
  const received: any[] = []
  const { instance, ws, identityPath } = await bootstrapConnector({
    onMessage: async (msg) => {
      received.push(msg)
      return 'history-pong'
    },
    config: {
      sessionKey: 'agent:main:main',
      historyPoll: true,
      historyPollMs: 500,
    },
  })

  try {
    await performHandshake(ws)

    const firstHistoryReq = await waitFor(
      () => findReqAt(ws, 'chat.history', 0),
      2_500,
    )
    assert.equal((firstHistoryReq.params as any)?.sessionKey, 'agent:main:main')
    ws.emit({
      type: 'res',
      id: firstHistoryReq.id as string,
      ok: true,
      payload: {
        sessionKey: 'agent:main:main',
        messages: [
          {
            role: 'user',
            timestamp: 1,
            content: [{ type: 'text', text: 'old message' }],
          },
        ],
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(received.length, 0)

    const secondHistoryReq = await waitFor(
      () => findReqAt(ws, 'chat.history', 1),
      3_000,
    )
    ws.emit({
      type: 'res',
      id: secondHistoryReq.id as string,
      ok: true,
      payload: {
        sessionKey: 'agent:main:main',
        messages: [
          {
            role: 'user',
            timestamp: 1,
            content: [{ type: 'text', text: 'old message' }],
          },
          {
            role: 'user',
            timestamp: 2,
            content: [{ type: 'text', text: 'new message' }],
          },
        ],
      },
    })

    const chatReq = await waitFor(() => findReq(ws, 'chat.send'), 2_000)
    assert.equal((chatReq.params as any)?.sessionKey, 'agent:main:main')
    assert.equal((chatReq.params as any)?.message, 'history-pong')
    assert.equal(received.length, 1)
    assert.equal(received[0]?.text, 'new message')

    ws.emit({
      type: 'res',
      id: chatReq.id as string,
      ok: true,
      payload: { runId: 'history-run' },
    })
  } finally {
    await instance.stop()
    fs.rmSync(identityPath, { force: true })
  }
})

test('openclaw connector reconnects when tick watchdog detects stale connection', async () => {
  const { instance, ws, identityPath } = await bootstrapConnector()

  try {
    await performHandshake(ws, {
      type: 'hello-ok',
      protocol: 3,
      policy: { tickIntervalMs: 200 },
    })

    await waitFor(() => MockWebSocket.instances.length >= 2 ? MockWebSocket.instances[1] : null, 7_000, 25)
    assert.ok(MockWebSocket.instances.length >= 2)
  } finally {
    await instance.stop()
    fs.rmSync(identityPath, { force: true })
  }
})
