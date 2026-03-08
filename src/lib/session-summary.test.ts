import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Session } from '@/types'
import {
  buildSessionListSummary,
  getSessionLastAssistantAt,
  getSessionLastMessage,
  getSessionMessageCount,
} from './session-summary'

function makeSession(): Session {
  return {
    id: 'session-1',
    name: 'Test Session',
    cwd: '/tmp',
    user: 'default',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    messages: [
      { role: 'user', text: 'hello', time: 1 },
      { role: 'assistant', text: 'world', time: 2, toolEvents: [{ name: 'shell', input: '{}', output: 'ok' }] },
    ],
    createdAt: 1,
    lastActiveAt: 2,
  }
}

describe('session summary helpers', () => {
  it('builds lightweight list summaries without full message history', () => {
    const session = makeSession()
    const summary = buildSessionListSummary(session)

    assert.equal(summary.messages.length, 0)
    assert.equal(summary.messageCount, 2)
    assert.equal(summary.lastAssistantAt, 2)
    assert.equal(summary.lastMessageSummary?.text, 'world')
    assert.equal(summary.lastMessageSummary?.toolEvents, undefined)
  })

  it('reads summary metadata when available', () => {
    const summary = buildSessionListSummary(makeSession())

    assert.equal(getSessionMessageCount(summary), 2)
    assert.equal(getSessionLastAssistantAt(summary), 2)
    assert.equal(getSessionLastMessage(summary)?.text, 'world')
  })
})
