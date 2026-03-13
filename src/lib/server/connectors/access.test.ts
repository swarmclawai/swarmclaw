import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Connector } from '@/types'
import {
  applyConnectorAccessMetadata,
  buildConnectorAccessSnapshot,
  enforceInboundAccessPolicy,
  resolvePairingAccess,
} from './access'
import { listPendingPairingRequests } from './pairing'

async function withTempDataDir<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.DATA_DIR
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-access-test-'))
  process.env.DATA_DIR = tempDir
  try {
    return await fn()
  } finally {
    if (typeof original === 'string') process.env.DATA_DIR = original
    else delete process.env.DATA_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function makeConnector(config: Record<string, string> = {}): Connector {
  const now = Date.now()
  return {
    id: 'conn_access',
    name: 'WhatsApp',
    platform: 'whatsapp',
    agentId: 'agent_1',
    credentialId: null,
    config,
    isEnabled: true,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  }
}

test('configured owner override marks the inbound message as owner conversation and bypasses normal approval checks', async () => {
  await withTempDataDir(() => {
    const connector = makeConnector({
      ownerSenderId: '15550001111',
      dmPolicy: 'allowlist',
      denyFrom: '15550001111',
    })
    const inbound = applyConnectorAccessMetadata(connector, {
      platform: 'whatsapp',
      channelId: '15550001111@s.whatsapp.net',
      senderId: '15550001111@s.whatsapp.net',
      senderName: 'Wayde',
      text: 'hello',
    })
    const access = resolvePairingAccess(connector, inbound)

    assert.equal(inbound.isOwnerConversation, true)
    assert.equal(access.isOwnerConversation, true)
    assert.equal(access.isDenied, false)
    assert.equal(access.isAllowed, true)
  })
})

test('deny list blocks a sender before pairing and does not create a pending request', async () => {
  await withTempDataDir(async () => {
    const connector = makeConnector({
      dmPolicy: 'pairing',
      denyFrom: '16660002222',
    })
    const result = await enforceInboundAccessPolicy({
      connector,
      msg: {
        platform: 'whatsapp',
        channelId: '16660002222@s.whatsapp.net',
        senderId: '16660002222@s.whatsapp.net',
        senderName: 'Bob',
        text: 'hello',
      },
      noMessageSentinel: 'NO_MESSAGE',
    })

    assert.match(result || '', /blocked for this connector/i)
    assert.equal(listPendingPairingRequests(connector.id).length, 0)
  })
})

test('dm addressing mode can suppress unaddressed DMs while allowing explicit agent-name triggers', async () => {
  await withTempDataDir(async () => {
    const connector = makeConnector({
      dmAddressingMode: 'addressed',
    })

    const silent = await enforceInboundAccessPolicy({
      connector,
      msg: {
        platform: 'whatsapp',
        channelId: '15550001111@s.whatsapp.net',
        senderId: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Dinner is ready.',
      },
      aliases: ['Nova'],
      noMessageSentinel: 'NO_MESSAGE',
    })
    assert.equal(silent, 'NO_MESSAGE')

    const addressed = await enforceInboundAccessPolicy({
      connector,
      msg: {
        platform: 'whatsapp',
        channelId: '15550001111@s.whatsapp.net',
        senderId: '15550001111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Nova, can you remind me tomorrow morning?',
      },
      aliases: ['Nova'],
      noMessageSentinel: 'NO_MESSAGE',
    })
    assert.equal(addressed, null)
  })
})

test('access snapshot classifies selected sender status across owner, pending, and deny signals', () => {
  return withTempDataDir(() => {
    const connector = makeConnector({
      ownerSenderId: '15550001111',
      denyFrom: '16660002222',
      dmAddressingMode: 'addressed',
    })
    const snapshot = buildConnectorAccessSnapshot({
      connector,
      senderId: '16660002222@s.whatsapp.net',
      senderIdAlt: null,
    })

    assert.equal(snapshot.senderStatus?.isBlocked, true)
    assert.equal(snapshot.senderStatus?.isApproved, false)
    assert.equal(snapshot.senderStatus?.requiresDirectAddress, true)
    assert.equal(snapshot.ownerSenderId, '15550001111')
    assert.deepEqual(snapshot.denyFrom, ['16660002222'])
    assert.equal(snapshot.dmAddressingMode, 'addressed')
  })
})
