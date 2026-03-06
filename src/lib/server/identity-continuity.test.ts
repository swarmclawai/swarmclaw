import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '@/types'
import { buildIdentityContinuityContext, refreshSessionIdentityState } from './identity-continuity'

test('buildIdentityContinuityContext merges agent and session continuity', () => {
  const block = buildIdentityContinuityContext(
    {
      name: 'Thread A',
      conversationTone: 'technical',
      identityState: {
        personaLabel: 'Debugger',
        relationshipSummary: 'Working with the user on a production issue.',
      },
    } as Partial<Session>,
    {
      name: 'Swarmy',
      description: 'Helpful coding agent',
      identityState: {
        boundaries: ['Do not pretend work is complete without evidence.'],
        continuityNotes: ['User prefers concise explanations.'],
      },
    },
  )

  assert.match(block, /Identity Continuity/)
  assert.match(block, /Current persona: Debugger/)
  assert.match(block, /Observed tone: technical/)
  assert.match(block, /User prefers concise explanations/)
})

test('refreshSessionIdentityState derives fallback continuity fields', () => {
  const session = {
    id: 's1',
    name: 'Checkout Bug',
    cwd: process.cwd(),
    user: 'Taylor',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    messages: [{ role: 'user', text: 'Help', time: 1 }],
    createdAt: 1,
    lastActiveAt: 1,
    conversationTone: 'focused',
    connectorContext: { threadId: 'thread-9', senderName: 'Taylor' },
  } as Session

  const state = refreshSessionIdentityState(session, {
    name: 'Swarmy',
    description: 'Helpful coding agent',
  }, 100)

  assert.equal(state.personaLabel, 'Swarmy thread thread-9')
  assert.equal(state.relationshipSummary, 'Ongoing conversation with Taylor.')
  assert.equal(state.toneStyle, 'focused')
  assert.equal(state.updatedAt, 100)
})

test('buildIdentityContinuityContext prefers thread persona labels from connector context', () => {
  const block = buildIdentityContinuityContext(
    {
      name: 'Connector Session',
      connectorContext: {
        threadId: 'thread-9',
        threadPersonaLabel: 'Checkout Incident',
      },
    } as Partial<Session>,
    {
      name: 'Swarmy',
      description: 'Helpful coding agent',
    },
  )

  assert.match(block, /Current persona: Checkout Incident/)
})
