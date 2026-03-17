import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@/types'
import {
  buildStreamingAwareMessageList,
  materializeStreamingAssistantArtifacts,
  mergeCompletedAssistantMessage,
  messagesDiffer,
  pruneStreamingAssistantArtifacts,
  reconcileClientMessageMetadata,
  shouldHidePersistedStreamingAssistantMessage,
  upsertStreamingAssistantArtifact,
  type StreamingAwareMessageListOptions,
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
      shouldHidePersistedStreamingAssistantMessage(message, { localStreaming: true, hasLiveArtifacts: true }),
      true,
    )
    assert.equal(
      shouldHidePersistedStreamingAssistantMessage(message, { localStreaming: true, hasLiveArtifacts: false }),
      false,
    )
  })

  it('replaces hidden streaming artifacts with a synthetic inline live assistant row', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'partial', time: 2, streaming: true },
    ]

    assert.deepEqual(
      buildStreamingAwareMessageList(messages, {
        localStreaming: true,
        hasLiveArtifacts: true,
        assistantRenderId: 'render-1',
        showLiveRow: true,
        syntheticAssistant: messages[1],
      } as StreamingAwareMessageListOptions),
      [
        { role: 'user', text: 'hello', time: 1 },
        {
          role: 'assistant',
          text: 'partial',
          time: 2,
          kind: 'chat',
          streaming: true,
          clientRenderId: 'render-1',
        },
      ],
    )
  })

  it('adds a synthetic inline live row for tool-only turns', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
    ]

    assert.deepEqual(
      buildStreamingAwareMessageList(messages, {
        localStreaming: true,
        hasLiveArtifacts: true,
        assistantRenderId: 'render-2',
        showLiveRow: true,
      } as StreamingAwareMessageListOptions),
      [
        { role: 'user', text: 'hello', time: 1 },
        {
          role: 'assistant',
          text: '',
          time: 0,
          kind: 'chat',
          streaming: true,
          clientRenderId: 'render-2',
        },
      ],
    )
  })

  it('can show a synthetic live row for server-driven runs using the latest persisted streaming artifact', () => {
    const messages: Message[] = [
      { role: 'user', text: 'queued follow-up', time: 1 },
      {
        role: 'assistant',
        text: 'Drafting the handoff now.',
        time: 2,
        streaming: true,
        thinking: 'Collecting the completion details',
        toolEvents: [{ name: 'send_file', input: '{}', output: '/api/uploads/deck.pdf' }],
      },
    ]

    assert.deepEqual(
      buildStreamingAwareMessageList(messages, {
        localStreaming: true,
        hasLiveArtifacts: false,
        assistantRenderId: 'render-server',
        showLiveRow: true,
        syntheticAssistant: messages[1],
      }),
      [
        { role: 'user', text: 'queued follow-up', time: 1 },
        {
          role: 'assistant',
          text: 'Drafting the handoff now.',
          time: 2,
          kind: 'chat',
          streaming: true,
          thinking: 'Collecting the completion details',
          toolEvents: [{ name: 'send_file', input: '{}', output: '/api/uploads/deck.pdf' }],
          clientRenderId: 'render-server',
        },
      ],
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

  it('materializes stale streaming artifacts into ordinary assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      {
        role: 'assistant',
        text: 'partial result',
        time: 2,
        streaming: true,
        toolEvents: [{ name: 'browser', input: '{"action":"screenshot"}', output: '/api/uploads/wiki.png' }],
      },
    ]

    const changed = materializeStreamingAssistantArtifacts(messages)

    assert.equal(changed, true)
    assert.deepEqual(messages, [
      { role: 'user', text: 'hello', time: 1 },
      {
        role: 'assistant',
        text: 'partial result',
        time: 2,
        streaming: false,
        toolEvents: [{ name: 'browser', input: '{"action":"screenshot"}', output: '/api/uploads/wiki.png' }],
      },
    ])
  })

  it('summarizes tool-only stale streaming artifacts instead of dropping them', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      {
        role: 'assistant',
        text: '',
        time: 2,
        streaming: true,
        toolEvents: [{ name: 'browser', input: '{"action":"screenshot"}' }],
      },
    ]

    materializeStreamingAssistantArtifacts(messages)

    assert.match(messages[1].text, /Started 1 tool call/)
    assert.equal(messages[1].streaming, false)
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

  it('reuses the previous assistant slot when only streaming whitespace differs', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'Here are the results.', time: 2, kind: 'chat' },
    ]
    const completed: Message = { role: 'assistant', text: 'Here\n\n are the results.', time: 3, kind: 'chat' }

    assert.deepEqual(mergeCompletedAssistantMessage(messages, completed), [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'Here\n\n are the results.', time: 2, kind: 'chat' },
    ])
  })

  it('materializes a stale streaming artifact into the existing completed assistant slot', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      {
        role: 'assistant',
        text: 'Here are the results.',
        time: 2,
        kind: 'chat',
      },
      {
        role: 'assistant',
        text: 'Here\n\n are the results.',
        time: 3,
        streaming: true,
        toolEvents: [{ name: 'web', input: '{"action":"search"}' }],
      },
    ]

    const changed = materializeStreamingAssistantArtifacts(messages)

    assert.equal(changed, true)
    assert.deepEqual(messages, [
      { role: 'user', text: 'hello', time: 1 },
      {
        role: 'assistant',
        text: 'Here\n\n are the results.',
        time: 2,
        kind: 'chat',
        streaming: false,
        toolEvents: [{ name: 'web', input: '{"action":"search"}' }],
      },
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

  it('preserves client render ids when refreshed messages reconcile to the same content', () => {
    const previous: Message[] = [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'final', time: 2, clientRenderId: 'render-3' },
    ]
    const next: Message[] = [
      { role: 'user', text: 'hello', time: 10 },
      { role: 'assistant', text: 'final', time: 20 },
    ]

    assert.deepEqual(reconcileClientMessageMetadata(next, previous), [
      { role: 'user', text: 'hello', time: 10 },
      { role: 'assistant', text: 'final', time: 20, clientRenderId: 'render-3' },
    ])
  })
})
