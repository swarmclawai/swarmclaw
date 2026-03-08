import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupeMessagesForDisplay, formatMessageTimestamp } from './chat-display'
import type { Message } from '@/types'

function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    role: 'user',
    text: 'hello',
    time: Date.now(),
    ...overrides,
  }
}

test('dedupeMessagesForDisplay removes exact connector duplicates by message id', () => {
  const first = baseMessage({
    source: {
      platform: 'whatsapp',
      connectorId: 'conn-1',
      connectorName: 'WhatsApp',
      messageId: 'wamid-1',
      senderName: 'Alice',
    },
    historyExcluded: true,
  })
  const duplicate = { ...first }
  const unrelated = baseMessage({
    text: 'reply',
    role: 'assistant',
    source: {
      platform: 'whatsapp',
      connectorId: 'conn-1',
      connectorName: 'WhatsApp',
      messageId: 'wamid-2',
      senderName: 'Alice',
    },
    historyExcluded: true,
  })

  const result = dedupeMessagesForDisplay([first, duplicate, unrelated])

  assert.equal(result.length, 2)
  assert.equal(result[0].source?.messageId, 'wamid-1')
  assert.equal(result[1].source?.messageId, 'wamid-2')
})

test('dedupeMessagesForDisplay keeps identical connector text from distinct message ids', () => {
  const first = baseMessage({
    source: {
      platform: 'whatsapp',
      connectorId: 'conn-1',
      connectorName: 'WhatsApp',
      messageId: 'wamid-1',
      senderName: 'Alice',
    },
    historyExcluded: true,
  })
  const second = baseMessage({
    source: {
      platform: 'whatsapp',
      connectorId: 'conn-1',
      connectorName: 'WhatsApp',
      messageId: 'wamid-2',
      senderName: 'Alice',
    },
    historyExcluded: true,
  })

  const result = dedupeMessagesForDisplay([first, second])

  assert.equal(result.length, 2)
  assert.deepEqual(result.map((message) => message.source?.messageId), ['wamid-1', 'wamid-2'])
})

test('formatMessageTimestamp uses exact time formatting for connector transcript entries', () => {
  const now = new Date()
  now.setHours(14, 5, 0, 0)
  const timestamp = now.getTime()
  const formatted = formatMessageTimestamp({
    time: timestamp,
    source: {
      platform: 'whatsapp',
      connectorId: 'conn-1',
      connectorName: 'WhatsApp',
    },
  })

  assert.match(formatted, /\d{1,2}:\d{2}/)
  assert.doesNotMatch(formatted, /ago|just now/)
})
