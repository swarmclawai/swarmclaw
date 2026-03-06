import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '@/types'
import { pruneSuppressedHeartbeatStreamMessage, shouldApplySessionFreshnessReset } from './chat-execution'

describe('pruneSuppressedHeartbeatStreamMessage', () => {
  it('removes a trailing streaming assistant heartbeat artifact', () => {
    const messages: Message[] = [
      { role: 'assistant', text: 'real reply', time: 1, kind: 'chat' },
      { role: 'assistant', text: 'HEARTBEAT_OK', time: 2, streaming: true },
    ]

    const changed = pruneSuppressedHeartbeatStreamMessage(messages)

    assert.equal(changed, true)
    assert.deepEqual(messages, [
      { role: 'assistant', text: 'real reply', time: 1, kind: 'chat' },
    ])
  })

  it('keeps non-streaming or user messages intact', () => {
    const nonStreaming: Message[] = [
      { role: 'assistant', text: 'HEARTBEAT_OK', time: 2, kind: 'heartbeat' },
    ]
    const userTail: Message[] = [
      { role: 'user', text: 'ping', time: 3, streaming: true },
    ]

    assert.equal(pruneSuppressedHeartbeatStreamMessage(nonStreaming), false)
    assert.equal(pruneSuppressedHeartbeatStreamMessage(userTail), false)
    assert.equal(nonStreaming.length, 1)
    assert.equal(userTail.length, 1)
  })

  it('applies freshness resets beyond heartbeat but skips eval runs', () => {
    assert.equal(shouldApplySessionFreshnessReset('chat'), true)
    assert.equal(shouldApplySessionFreshnessReset('heartbeat'), true)
    assert.equal(shouldApplySessionFreshnessReset('eval'), false)
  })
})
