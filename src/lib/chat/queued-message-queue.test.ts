import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  clearQueuedMessagesForSession,
  listQueuedMessagesForSession,
  removeQueuedMessageById,
  shiftQueuedMessageForSession,
  type QueuedSessionMessage,
} from '@/lib/chat/queued-message-queue'

describe('queued-message-queue', () => {
  const queue: QueuedSessionMessage[] = [
    { id: 'q1', sessionId: 'session-a', text: 'first a' },
    { id: 'q2', sessionId: 'session-b', text: 'first b' },
    { id: 'q3', sessionId: 'session-a', text: 'second a' },
  ]

  it('lists queued messages for a single session', () => {
    assert.deepEqual(
      listQueuedMessagesForSession(queue, 'session-a').map((item) => item.id),
      ['q1', 'q3'],
    )
  })

  it('shifts only the next queued item for the requested session', () => {
    const shifted = shiftQueuedMessageForSession(queue, 'session-a')
    assert.equal(shifted.next?.id, 'q1')
    assert.deepEqual(shifted.queue.map((item) => item.id), ['q2', 'q3'])
  })

  it('removes queued items by stable id', () => {
    assert.deepEqual(removeQueuedMessageById(queue, 'q2').map((item) => item.id), ['q1', 'q3'])
  })

  it('clears queued items only for the given session', () => {
    assert.deepEqual(
      clearQueuedMessagesForSession(queue, 'session-a').map((item) => item.id),
      ['q2'],
    )
  })
})
