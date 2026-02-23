import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createGatewayRequestFrame,
  parseGatewayFrame,
  serializeGatewayFrame,
} from './protocol.ts'

test('gateway protocol parses request/response/event frames', () => {
  const req = parseGatewayFrame('{"type":"req","id":"1","method":"connect","params":{"foo":"bar"}}')
  assert.deepEqual(req, {
    type: 'req',
    id: '1',
    method: 'connect',
    params: { foo: 'bar' },
  })

  const res = parseGatewayFrame('{"type":"res","id":"1","ok":true,"payload":{"ok":true}}')
  assert.deepEqual(res, {
    type: 'res',
    id: '1',
    ok: true,
    payload: { ok: true },
    error: null,
  })

  const event = parseGatewayFrame('{"type":"event","event":"tick","payload":{"n":1}}')
  assert.deepEqual(event, {
    type: 'event',
    event: 'tick',
    payload: { n: 1 },
  })
})

test('gateway protocol rejects malformed frames', () => {
  assert.equal(parseGatewayFrame('not-json'), null)
  assert.equal(parseGatewayFrame('{"type":"event"}'), null)
  assert.equal(parseGatewayFrame('{"type":"req","id":"1"}'), null)
  assert.equal(parseGatewayFrame({ nope: true }), null)
})

test('gateway request helper and serializer produce valid frame', () => {
  const frame = createGatewayRequestFrame('abc', 'chat.send', { message: 'hello' })
  assert.deepEqual(frame, {
    type: 'req',
    id: 'abc',
    method: 'chat.send',
    params: { message: 'hello' },
  })

  const encoded = serializeGatewayFrame(frame)
  const decoded = parseGatewayFrame(encoded)
  assert.deepEqual(decoded, frame)
})
