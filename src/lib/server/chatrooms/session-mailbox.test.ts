import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let mailbox: typeof import('@/lib/server/chatrooms/session-mailbox')
let storage: typeof import('@/lib/server/storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-mailbox-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  storage = await import('@/lib/server/storage')
  mailbox = await import('@/lib/server/chatrooms/session-mailbox')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createTestSession(id: string): void {
  const sessions = storage.loadSessions()
  sessions[id] = {
    id,
    agentId: 'agent-1',
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  }
  storage.saveSessions(sessions)
}

describe('session-mailbox', () => {
  it('sends an envelope to a session', () => {
    createTestSession('mb-sess-1')
    const env = mailbox.sendMailboxEnvelope({
      toSessionId: 'mb-sess-1',
      type: 'message',
      payload: 'hello from sender',
      fromSessionId: 'mb-sess-0',
    })
    assert.ok(env.id)
    assert.equal(env.toSessionId, 'mb-sess-1')
    assert.equal(env.type, 'message')
    assert.equal(env.payload, 'hello from sender')
    assert.equal(env.status, 'new')
    assert.equal(env.expiresAt, null)
  })

  it('throws when target session does not exist', () => {
    assert.throws(
      () => mailbox.sendMailboxEnvelope({ toSessionId: 'nonexistent', type: 'msg', payload: 'hi' }),
      /Target session not found/,
    )
  })

  it('lists envelopes for a session', () => {
    createTestSession('mb-sess-2')
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-2', type: 'msg', payload: 'first' })
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-2', type: 'msg', payload: 'second' })
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-2', type: 'msg', payload: 'third' })

    const list = mailbox.listMailbox('mb-sess-2')
    assert.equal(list.length, 3)
    // All three payloads are present
    const payloads = list.map((e) => e.payload).sort()
    assert.deepEqual(payloads, ['first', 'second', 'third'])
  })

  it('ack hides envelope from default list', () => {
    createTestSession('mb-sess-3')
    const env = mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-3', type: 'msg', payload: 'ack-me' })

    const acked = mailbox.ackMailboxEnvelope('mb-sess-3', env.id)
    assert.ok(acked)
    assert.equal(acked!.status, 'ack')
    assert.ok(acked!.ackAt! > 0)

    // Default list excludes acked
    const list = mailbox.listMailbox('mb-sess-3')
    assert.equal(list.length, 0)

    // With includeAcked = true
    const listAll = mailbox.listMailbox('mb-sess-3', { includeAcked: true })
    assert.equal(listAll.length, 1)
    assert.equal(listAll[0].status, 'ack')
  })

  it('ack returns null for non-existent envelope', () => {
    createTestSession('mb-sess-4')
    const result = mailbox.ackMailboxEnvelope('mb-sess-4', 'no-such-id')
    assert.equal(result, null)
  })

  it('clearMailbox removes all envelopes', () => {
    createTestSession('mb-sess-5')
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-5', type: 'msg', payload: 'a' })
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-5', type: 'msg', payload: 'b' })

    const result = mailbox.clearMailbox('mb-sess-5')
    assert.equal(result.before, 2)
    assert.equal(result.after, 0)

    const list = mailbox.listMailbox('mb-sess-5', { includeAcked: true })
    assert.equal(list.length, 0)
  })

  it('clearMailbox with includeAcked=false only removes acked', () => {
    createTestSession('mb-sess-6')
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-6', type: 'msg', payload: 'keep' })
    const env2 = mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-6', type: 'msg', payload: 'ack-then-remove' })
    mailbox.ackMailboxEnvelope('mb-sess-6', env2.id)

    const result = mailbox.clearMailbox('mb-sess-6', false)
    // includeAcked=false means "only clear acked items" — wait, let me re-read the code
    // Actually: includeAcked=true means clear everything, false means only keep non-acked (clear acked)
    // const afterList = includeAcked ? [] : list.filter((env) => env.status !== 'ack')
    // So includeAcked=false keeps non-acked (removes acked)
    assert.equal(result.before, 2)
    assert.equal(result.after, 1) // the non-acked one remains
  })

  it('mailbox isolation: messages to one session do not appear in another', () => {
    createTestSession('mb-iso-1')
    createTestSession('mb-iso-2')
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-iso-1', type: 'msg', payload: 'for iso-1' })
    mailbox.sendMailboxEnvelope({ toSessionId: 'mb-iso-2', type: 'msg', payload: 'for iso-2' })

    const list1 = mailbox.listMailbox('mb-iso-1')
    const list2 = mailbox.listMailbox('mb-iso-2')

    assert.equal(list1.length, 1)
    assert.equal(list1[0].payload, 'for iso-1')
    assert.equal(list2.length, 1)
    assert.equal(list2[0].payload, 'for iso-2')
  })

  it('respects limit option', () => {
    createTestSession('mb-sess-limit')
    for (let i = 0; i < 10; i++) {
      mailbox.sendMailboxEnvelope({ toSessionId: 'mb-sess-limit', type: 'msg', payload: `msg-${i}` })
    }
    const list = mailbox.listMailbox('mb-sess-limit', { limit: 3 })
    assert.equal(list.length, 3)
  })

  it('TTL sets expiresAt on envelope', () => {
    createTestSession('mb-sess-ttl')
    const env = mailbox.sendMailboxEnvelope({
      toSessionId: 'mb-sess-ttl',
      type: 'msg',
      payload: 'ephemeral',
      ttlSec: 60,
    })
    assert.ok(env.expiresAt)
    assert.ok(env.expiresAt! > env.createdAt)
    assert.ok(env.expiresAt! <= env.createdAt + 60_000 + 10) // small tolerance
  })

  it('listMailbox throws for non-existent session', () => {
    assert.throws(
      () => mailbox.listMailbox('no-such-session'),
      /Session not found/,
    )
  })

  it('default type is "message" when empty string provided', () => {
    createTestSession('mb-sess-type')
    const env = mailbox.sendMailboxEnvelope({
      toSessionId: 'mb-sess-type',
      type: '',
      payload: 'test',
    })
    assert.equal(env.type, 'message')
  })
})
