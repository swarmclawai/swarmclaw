import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '@/types'
import { buildSessionArchiveMarkdown, buildSessionArchivePayload } from '@/lib/server/memory/session-archive-memory'

test('buildSessionArchivePayload summarizes session transcript and metadata', () => {
  const session = {
    id: 'session-1',
    name: 'Support Thread',
    cwd: process.cwd(),
    user: 'Alice',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    createdAt: Date.parse('2026-03-05T00:00:00.000Z'),
    lastActiveAt: Date.parse('2026-03-05T10:00:00.000Z'),
    sessionType: 'human',
    messages: [
      { role: 'user', text: 'Can you help me debug this issue?', time: 1 },
      { role: 'assistant', text: 'Yes, show me the stack trace.', time: 2, toolEvents: [{ name: 'files', input: '{}' }] },
    ],
    identityState: { personaLabel: 'Debugger' },
  } as Session

  const payload = buildSessionArchivePayload(session, { name: 'Swarmy' })

  assert.ok(payload)
  assert.equal(payload?.title, 'Session archive: Support Thread')
  assert.match(payload?.content || '', /Transcript excerpt:/)
  assert.match(payload?.content || '', /Swarmy/)
  assert.equal(payload?.metadata.tier, 'archive')
  assert.equal(payload?.references[0]?.type, 'session')
})

test('buildSessionArchiveMarkdown creates a portable markdown snapshot', () => {
  const session = {
    id: 'session-3',
    name: 'Architecture Review',
    cwd: process.cwd(),
    user: 'Alice',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    createdAt: Date.parse('2026-03-05T00:00:00.000Z'),
    lastActiveAt: Date.parse('2026-03-05T10:00:00.000Z'),
    sessionType: 'human',
    messages: [
      { role: 'user', text: 'Summarize the new connector policy.', time: 1 },
      { role: 'assistant', text: 'It now uses scoped sessions and freshness resets.', time: 2 },
    ],
    identityState: { personaLabel: 'Reviewer' },
  } as Session

  const payload = buildSessionArchivePayload(session, { name: 'Swarmy' })
  assert.ok(payload)

  const markdown = buildSessionArchiveMarkdown(session, payload!, { name: 'Swarmy' })
  assert.match(markdown, /^# Session archive: Architecture Review/m)
  assert.match(markdown, /## Archive Snapshot/)
  assert.match(markdown, /## Transcript Excerpt/)
  assert.match(markdown, /\*\*Swarmy\*\*/)
})

test('buildSessionArchivePayload skips trivial sessions', () => {
  const session = {
    id: 'session-2',
    name: 'Too Short',
    cwd: process.cwd(),
    user: 'Bob',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    createdAt: 1,
    lastActiveAt: 1,
    messages: [{ role: 'user', text: 'hi', time: 1 }],
  } as Session

  assert.equal(buildSessionArchivePayload(session), null)
})
