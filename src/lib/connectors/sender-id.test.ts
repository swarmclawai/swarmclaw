import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findMatchingSenderEntry,
  normalizeSenderId,
  senderIdVariants,
  senderMatchesAnyEntry,
} from './sender-id'

test('sender id helpers normalize and expand WhatsApp variants', () => {
  assert.equal(normalizeSenderId('  TEST@Example.com  '), 'test@example.com')
  assert.deepEqual(senderIdVariants('15550001111@s.whatsapp.net'), [
    '15550001111@s.whatsapp.net',
    '15550001111',
  ])
})

test('sender id helpers match phone, jid, and lid forms consistently', () => {
  assert.equal(
    senderMatchesAnyEntry(['15550001111@s.whatsapp.net', '199900000001@lid'], ['+1 (555) 000-1111']),
    true,
  )
  assert.equal(
    senderMatchesAnyEntry('alice@example.com', ['bob@example.com']),
    false,
  )
  assert.equal(
    findMatchingSenderEntry(['+1 (555) 000-1111', 'someone@example.com'], '15550001111@s.whatsapp.net'),
    '+1 (555) 000-1111',
  )
})
