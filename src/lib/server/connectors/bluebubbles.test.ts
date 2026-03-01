import assert from 'node:assert/strict'
import { test } from 'node:test'
import bluebubbles from './bluebubbles.ts'

type FetchCall = {
  url: string
  init?: RequestInit
}

type MockResponse = {
  ok: boolean
  status: number
  json: () => Promise<any>
  text: () => Promise<string>
}

function jsonResponse(status: number, body: unknown): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function textResponse(status: number, text: string): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json')
    },
    text: async () => text,
  }
}

const originalFetch = globalThis.fetch

test.afterEach(() => {
  ;(globalThis as any).fetch = originalFetch
})

test('bluebubbles connector processes inbound webhook payloads and sends replies', async () => {
  const calls: FetchCall[] = []
  const queue: MockResponse[] = [
    jsonResponse(200, { ok: true }), // ping
    jsonResponse(200, { data: { guid: 'msg-1' } }), // send reply
  ]

  ;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    assert.ok(next, 'unexpected fetch call')
    return next as any
  }

  const received: any[] = []
  const connector = {
    id: 'bb-1',
    name: 'BlueBubbles Test',
    platform: 'bluebubbles',
    agentId: 'agent-1',
    credentialId: null,
    config: {
      serverUrl: 'http://127.0.0.1:1234',
    },
    isEnabled: true,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any

  const instance = await bluebubbles.start(connector, 'pw-test', async (msg) => {
    received.push(msg)
    return 'pong'
  })

  try {
    const handler = (globalThis as any).__swarmclaw_bluebubbles_handler_bb_1__
    assert.equal(typeof handler, 'undefined', 'sanity: wrong handler key should be undefined')
    const validHandler = (globalThis as any)[`__swarmclaw_bluebubbles_handler_${connector.id}__`]
    assert.equal(typeof validHandler, 'function')

    await validHandler({
      type: 'new-message',
      data: {
        guid: 'm-123',
        text: 'hello there',
        isFromMe: false,
        isGroup: false,
        handle: { address: '+15551234567', displayName: 'Alice' },
        chatGuid: 'iMessage;-;+15551234567',
      },
    })

    assert.equal(received.length, 1)
    assert.equal(received[0].text, 'hello there')
    assert.equal(received[0].senderId, '+15551234567')
    assert.equal(received[0].channelId, 'iMessage;-;+15551234567')

    assert.equal(calls.length, 2)
    assert.ok(calls[0].url.includes('/api/v1/ping'))
    assert.ok(calls[1].url.includes('/api/v1/message/text'))

    const body = JSON.parse(String(calls[1].init?.body || '{}'))
    assert.equal(body.chatGuid, 'iMessage;-;+15551234567')
    assert.equal(body.message, 'pong')
  } finally {
    await instance.stop()
  }
})

test('bluebubbles connector supports array-wrapped webhook payload and NO_MESSAGE suppression', async () => {
  const calls: FetchCall[] = []
  const queue: MockResponse[] = [
    jsonResponse(200, { ok: true }), // ping
  ]

  ;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    assert.ok(next, 'unexpected fetch call')
    return next as any
  }

  const connector = {
    id: 'bb-2',
    name: 'BlueBubbles Test 2',
    platform: 'bluebubbles',
    agentId: 'agent-2',
    credentialId: null,
    config: {
      serverUrl: 'http://127.0.0.1:1234',
    },
    isEnabled: true,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any

  const instance = await bluebubbles.start(connector, 'pw-test', async () => 'NO_MESSAGE')

  try {
    const handler = (globalThis as any)[`__swarmclaw_bluebubbles_handler_${connector.id}__`]
    assert.equal(typeof handler, 'function')

    await handler({
      type: 'new-message',
      data: [
        {
          guid: 'm-124',
          text: '',
          isFromMe: false,
          handle: { address: 'test@example.com', displayName: 'Taylor' },
          chatGuid: 'iMessage;-;test@example.com',
          attachments: [{ mimeType: 'image/png', transferName: 'a.png', totalBytes: 128 }],
        },
      ],
    })

    assert.equal(calls.length, 1, 'should not call send endpoint when NO_MESSAGE is returned')
  } finally {
    await instance.stop()
  }
})

test('bluebubbles sendMessage posts to message/text endpoint', async () => {
  const calls: FetchCall[] = []
  const queue: MockResponse[] = [
    jsonResponse(200, { ok: true }), // ping
    textResponse(200, ''), // send
  ]

  ;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    assert.ok(next, 'unexpected fetch call')
    return next as any
  }

  const connector = {
    id: 'bb-3',
    name: 'BlueBubbles Test 3',
    platform: 'bluebubbles',
    agentId: 'agent-3',
    credentialId: null,
    config: {
      serverUrl: 'http://127.0.0.1:1234',
    },
    isEnabled: true,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any

  const instance = await bluebubbles.start(connector, 'pw-test', async () => 'ok')

  try {
    await instance.sendMessage?.('iMessage;-;+15550001111', 'hello outbound')
    assert.equal(calls.length, 2)
    assert.ok(calls[1].url.includes('/api/v1/message/text'))
    const body = JSON.parse(String(calls[1].init?.body || '{}'))
    assert.equal(body.chatGuid, 'iMessage;-;+15550001111')
    assert.equal(body.message, 'hello outbound')
  } finally {
    await instance.stop()
  }
})
