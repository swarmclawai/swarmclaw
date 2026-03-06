import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConnectorThreadContextBlock, resolveThreadPersonaLabel } from './thread-context'

test('resolveThreadPersonaLabel prefers explicit and title-based labels', () => {
  assert.equal(resolveThreadPersonaLabel({
    platform: 'slack',
    threadPersonaLabel: 'Incident Bridge',
    threadTitle: 'ignored',
    threadStarterText: 'ignored',
    threadId: 't1',
    channelName: 'ops',
  }), 'Incident Bridge')

  assert.equal(resolveThreadPersonaLabel({
    platform: 'discord',
    threadPersonaLabel: undefined,
    threadTitle: 'Release Coordination',
    threadStarterText: 'root message',
    threadId: 't1',
    channelName: 'deploys',
  }), 'Release Coordination')
})

test('buildConnectorThreadContextBlock includes starter, history, and first-turn note', () => {
  const block = buildConnectorThreadContextBlock({
    platform: 'slack',
    threadId: 'thread-1',
    threadTitle: 'Checkout Incident',
    threadStarterText: 'Prod checkout is returning 500s.',
    threadStarterSenderName: 'Alice',
    threadParentChannelName: 'incidents',
    threadHistory: [
      { role: 'assistant', senderName: 'Swarmy', text: 'I am tracing the failing service now.' },
      { role: 'user', senderName: 'Bob', text: 'Looks isolated to EU traffic.' },
    ],
  }, { isFirstThreadTurn: true })

  assert.match(block, /Native Thread Context/)
  assert.match(block, /Thread persona: Checkout Incident/)
  assert.match(block, /Thread starter: Alice: Prod checkout is returning 500s\./)
  assert.match(block, /first turn in a thread-bound session/i)
  assert.match(block, /\[assistant\] Swarmy: I am tracing the failing service now\./)
})
