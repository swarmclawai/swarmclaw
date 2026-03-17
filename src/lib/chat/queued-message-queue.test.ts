import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createOptimisticQueuedMessage,
  clearQueuedMessagesForSession,
  listQueuedMessagesForSession,
  removeQueuedMessageById,
  replaceQueuedMessagesForSession,
  snapshotToQueuedMessages,
  type QueuedSessionMessage,
} from '@/lib/chat/queued-message-queue'

describe('queued-message-queue', () => {
  const queue: QueuedSessionMessage[] = [
    { runId: 'q1', sessionId: 'session-a', text: 'first a', queuedAt: 1, position: 1 },
    { runId: 'q2', sessionId: 'session-b', text: 'first b', queuedAt: 2, position: 1 },
    { runId: 'q3', sessionId: 'session-a', text: 'second a', queuedAt: 3, position: 2 },
  ]

  it('lists queued messages for a single session', () => {
    assert.deepEqual(
      listQueuedMessagesForSession(queue, 'session-a').map((item) => item.runId),
      ['q1', 'q3'],
    )
  })

  it('replaces queued items only for the requested session', () => {
    const replaced = replaceQueuedMessagesForSession(queue, 'session-a', [
      { runId: 'q4', sessionId: 'session-a', text: 'replacement', queuedAt: 4, position: 1 },
    ], { activeRunId: null })
    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-a').map((item) => item.runId),
      ['q4'],
    )
    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-b').map((item) => item.runId),
      ['q2'],
    )
  })

  it('keeps only the newly active run as a sending placeholder when it disappears from the queue snapshot', () => {
    const replaced = replaceQueuedMessagesForSession(queue, 'session-a', [
      { runId: 'q3', sessionId: 'session-a', text: 'second a', queuedAt: 3, position: 1 },
    ], { activeRunId: 'q1' })

    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-a').map((item) => [item.runId, item.sending === true]),
      [['q1', true], ['q3', false]],
    )
  })

  it('drops missing stale queue rows that are not the active run', () => {
    const replaced = replaceQueuedMessagesForSession(queue, 'session-a', [
      { runId: 'q3', sessionId: 'session-a', text: 'second a', queuedAt: 3, position: 1 },
    ], { activeRunId: 'run-other' })

    assert.deepEqual(
      listQueuedMessagesForSession(replaced, 'session-a').map((item) => item.runId),
      ['q3'],
    )
  })

  it('removes queued items by stable id', () => {
    assert.deepEqual(removeQueuedMessageById(queue, 'q2').map((item) => item.runId), ['q1', 'q3'])
  })

  it('clears queued items only for the given session', () => {
    assert.deepEqual(
      clearQueuedMessagesForSession(queue, 'session-a').map((item) => item.runId),
      ['q2'],
    )
  })

  it('creates optimistic queued items with the expected shape', () => {
    const optimistic = createOptimisticQueuedMessage('session-a', { text: 'queued later' }, 3)
    assert.equal(optimistic.sessionId, 'session-a')
    assert.equal(optimistic.position, 3)
    assert.equal(optimistic.optimistic, true)
  })

  it('converts queue snapshots into local queued messages', () => {
    const queued = snapshotToQueuedMessages({
      sessionId: 'session-a',
      activeRunId: 'run-active',
      queueLength: 1,
      items: [
        { runId: 'run-queued', sessionId: 'session-a', text: 'queued', queuedAt: 5, position: 1 },
      ],
    })
    assert.deepEqual(queued.map((item) => item.runId), ['run-queued'])
  })

  it('preserves attachment and reply metadata from queue snapshots', () => {
    const queued = snapshotToQueuedMessages({
      sessionId: 'session-a',
      activeRunId: null,
      queueLength: 1,
      items: [
        {
          runId: 'run-queued-meta',
          sessionId: 'session-a',
          text: 'queued with files',
          queuedAt: 7,
          position: 1,
          imagePath: '/tmp/image.png',
          imageUrl: '/api/uploads/image.png',
          attachedFiles: ['/tmp/notes.txt', '/tmp/spec.md'],
          replyToId: 'msg-4',
        },
      ],
    })

    assert.deepEqual(queued[0], {
      runId: 'run-queued-meta',
      sessionId: 'session-a',
      text: 'queued with files',
      queuedAt: 7,
      position: 1,
      imagePath: '/tmp/image.png',
      imageUrl: '/api/uploads/image.png',
      attachedFiles: ['/tmp/notes.txt', '/tmp/spec.md'],
      replyToId: 'msg-4',
    })
  })

  it('sorts queued messages by position and queued time within a session', () => {
    const unsorted: QueuedSessionMessage[] = [
      { runId: 'q4', sessionId: 'session-a', text: 'later', queuedAt: 9, position: 2 },
      { runId: 'q5', sessionId: 'session-a', text: 'earlier same pos', queuedAt: 4, position: 1 },
      { runId: 'q6', sessionId: 'session-a', text: 'later same pos', queuedAt: 8, position: 1 },
    ]

    assert.deepEqual(
      listQueuedMessagesForSession(unsorted, 'session-a').map((item) => item.runId),
      ['q5', 'q6', 'q4'],
    )
  })
})
