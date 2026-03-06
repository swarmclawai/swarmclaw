import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@/types'
import {
  mergeCompletedAssistantMessage,
  messagesDiffer,
  pruneStreamingAssistantArtifacts,
  shouldHidePersistedStreamingAssistantMessage,
  upsertStreamingAssistantArtifact,
} from './chat-streaming-state'

describe('chat-streaming-state', () => {
  it('hides persisted streaming assistant artifacts while a local stream bubble is active', () => {
    const message: Message = {
      role: 'assistant',
      text: 'partial',
      time: 1,
      streaming: true,
    }

    assert.equal(
      shouldHidePersistedStreamingAssistantMessage(message, { localStreaming: true, displayText: 'live text' }),
      true,
    )
    assert.equal(
      shouldHidePersistedStreamingAssistantMessage(message, { localStreaming: true, displayText: '' }),
      true,
    )
  })

  it('replaces trailing streaming assistant messages with the completed assistant message', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'partial 1', time: 2, streaming: true },
      { role: 'assistant', text: 'partial 2', time: 3, streaming: true },
    ]
    const completed: Message = { role: 'assistant', text: 'final', time: 4 }

    assert.deepEqual(mergeCompletedAssistantMessage(messages, completed), [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'final', time: 4 },
    ])
  })

  it('prunes stale streaming artifacts without touching later system messages', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'partial', time: 10, streaming: true },
      { role: 'assistant', text: 'approval card', time: 11, kind: 'system' },
      { role: 'assistant', text: 'older partial', time: 12, streaming: true },
      { role: 'assistant', text: 'previous run', time: 2, streaming: true },
    ]

    const changed = pruneStreamingAssistantArtifacts(messages, { minIndex: 1, minTime: 10 })

    assert.equal(changed, true)
    assert.deepEqual(messages, [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'approval card', time: 11, kind: 'system' },
      { role: 'assistant', text: 'previous run', time: 2, streaming: true },
    ])
  })

  it('replaces the current run partial with the latest artifact after system messages', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'partial', time: 10, streaming: true },
      { role: 'assistant', text: 'approval card', time: 11, kind: 'system' },
    ]

    upsertStreamingAssistantArtifact(
      messages,
      { role: 'assistant', text: 'latest partial', time: 12, streaming: true },
      { minIndex: 1, minTime: 10 },
    )

    assert.deepEqual(messages, [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'approval card', time: 11, kind: 'system' },
      { role: 'assistant', text: 'latest partial', time: 12, streaming: true },
    ])
  })

  it('reuses the previous assistant slot when the server already persisted the same final text', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'final', time: 2, kind: 'chat' },
    ]
    const completed: Message = { role: 'assistant', text: 'final', time: 3, kind: 'chat' }

    assert.deepEqual(mergeCompletedAssistantMessage(messages, completed), [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'final', time: 2, kind: 'chat' },
    ])
  })

  it('detects same-length message updates during reconciliation', () => {
    const previous: Message[] = [
      { role: 'assistant', text: 'partial', time: 1, streaming: true },
    ]
    const next: Message[] = [
      { role: 'assistant', text: 'final', time: 2, kind: 'chat' },
    ]

    assert.equal(messagesDiffer(next, previous), true)
    assert.equal(messagesDiffer(next, next), false)
  })
})
