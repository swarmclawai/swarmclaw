import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  addAllowedSender,
  approvePairingCode,
  clearConnectorPairingState,
  createOrTouchPairingRequest,
  isSenderAllowed,
  listPendingPairingRequests,
  listStoredAllowedSenders,
  parseAllowFromCsv,
  parsePairingPolicy,
} from './pairing.ts'

function withTempDataDir<T>(fn: (dir: string) => T): T {
  const original = process.env.DATA_DIR
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-pairing-test-'))
  process.env.DATA_DIR = tempDir
  try {
    return fn(tempDir)
  } finally {
    if (typeof original === 'string') process.env.DATA_DIR = original
    else delete process.env.DATA_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('pairing store creates request, approves code, and persists allowlist', () => {
  withTempDataDir(() => {
    const connectorId = 'pair-test-1'

    const first = createOrTouchPairingRequest({
      connectorId,
      senderId: '+15551234567',
      senderName: 'Alice',
      channelId: 'chat:1',
    })
    assert.equal(first.created, true)
    assert.equal(first.code.length, 8)

    const second = createOrTouchPairingRequest({
      connectorId,
      senderId: '+15551234567',
      senderName: 'Alice',
      channelId: 'chat:1',
    })
    assert.equal(second.created, false)
    assert.equal(second.code, first.code)

    const pendingBefore = listPendingPairingRequests(connectorId)
    assert.equal(pendingBefore.length, 1)
    assert.equal(pendingBefore[0].senderId, '+15551234567')

    const bad = approvePairingCode(connectorId, 'INVALID')
    assert.equal(bad.ok, false)

    const approved = approvePairingCode(connectorId, first.code)
    assert.equal(approved.ok, true)
    assert.equal(approved.senderId, '+15551234567')

    const pendingAfter = listPendingPairingRequests(connectorId)
    assert.equal(pendingAfter.length, 0)

    const stored = listStoredAllowedSenders(connectorId)
    assert.deepEqual(stored, ['+15551234567'])

    assert.equal(isSenderAllowed({ connectorId, senderId: '+15551234567' }), true)
    assert.equal(isSenderAllowed({ connectorId, senderId: '+16667778888' }), false)

    clearConnectorPairingState(connectorId)
    assert.deepEqual(listStoredAllowedSenders(connectorId), [])
  })
})

test('pairing helpers normalize policy and allowFrom csv entries', () => {
  assert.equal(parsePairingPolicy('PAIRING'), 'pairing')
  assert.equal(parsePairingPolicy('allowlist'), 'allowlist')
  assert.equal(parsePairingPolicy('unknown', 'open'), 'open')

  const list = parseAllowFromCsv('  +1555,TEST@example.com,+1555  ,   ')
  assert.deepEqual(list, ['+1555', 'test@example.com'])
})

test('addAllowedSender deduplicates and normalizes sender ids', () => {
  withTempDataDir(() => {
    const connectorId = 'pair-test-2'
    const first = addAllowedSender(connectorId, '  TEST@Example.com  ')
    assert.equal(first.added, true)
    assert.equal(first.normalized, 'test@example.com')

    const second = addAllowedSender(connectorId, 'test@example.com')
    assert.equal(second.added, false)

    assert.deepEqual(listStoredAllowedSenders(connectorId), ['test@example.com'])
  })
})
