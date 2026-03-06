import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '@/types'
import {
  evaluateSessionFreshness,
  inferSessionResetType,
  resetSessionRuntime,
  resolveSessionResetPolicy,
} from './session-reset-policy'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Test Session',
    cwd: process.cwd(),
    user: 'user',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    messages: [{ role: 'user', text: 'hello', time: 1 }],
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  }
}

test('inferSessionResetType distinguishes direct, group, and thread sessions', () => {
  assert.equal(inferSessionResetType(makeSession()), 'direct')
  assert.equal(inferSessionResetType(makeSession({ connectorContext: { isGroup: true } })), 'group')
  assert.equal(inferSessionResetType(makeSession({ connectorContext: { threadId: 'thread-1' } })), 'thread')
})

test('resolveSessionResetPolicy falls back to type defaults', () => {
  const direct = resolveSessionResetPolicy({ session: makeSession() })
  assert.equal(direct.mode, 'idle')
  assert.equal(direct.idleTimeoutSec, 12 * 60 * 60)

  const thread = resolveSessionResetPolicy({ session: makeSession({ connectorContext: { threadId: 'thread-1' } }) })
  assert.equal(thread.mode, 'idle')
  assert.equal(thread.idleTimeoutSec, 4 * 60 * 60)
})

test('evaluateSessionFreshness expires idle sessions', () => {
  const session = makeSession({ createdAt: 0, lastActiveAt: 0 })
  const policy = resolveSessionResetPolicy({
    session: { ...session, sessionIdleTimeoutSec: 10, sessionMaxAgeSec: 60 },
  })
  const freshness = evaluateSessionFreshness({ session, policy, now: 11_000 })
  assert.deepEqual(freshness.reason, 'idle_timeout:10')
  assert.equal(freshness.fresh, false)
})

test('evaluateSessionFreshness supports daily reset boundaries', () => {
  const session = makeSession({
    createdAt: Date.parse('2026-03-04T00:00:00.000Z'),
    lastActiveAt: Date.parse('2026-03-05T03:30:00.000Z'),
  })
  const policy = resolveSessionResetPolicy({
    session: {
      ...session,
      sessionResetMode: 'daily',
      sessionDailyResetAt: '04:00',
      sessionResetTimezone: 'UTC',
      sessionMaxAgeSec: 999999,
      sessionIdleTimeoutSec: 0,
    },
  })
  const freshness = evaluateSessionFreshness({
    session,
    policy,
    now: Date.parse('2026-03-05T10:00:00.000Z'),
  })
  assert.equal(freshness.fresh, false)
  assert.equal(freshness.reason, 'daily_reset:04:00')
})

test('resetSessionRuntime clears transient state but preserves continuity state', () => {
  const session = makeSession({
    claudeSessionId: 'claude',
    codexThreadId: 'codex',
    opencodeSessionId: 'open',
    delegateResumeIds: { claudeCode: 'a', codex: 'b', opencode: 'c', gemini: 'd' },
    lastHeartbeatText: 'heartbeat',
    lastHeartbeatSentAt: 123,
    lastAutoMemoryAt: 456,
    conversationTone: 'formal',
    identityState: { personaLabel: 'Planner' },
  })

  const cleared = resetSessionRuntime(session, 'idle_timeout:10', { now: 1000 })

  assert.equal(cleared, 1)
  assert.deepEqual(session.messages, [])
  assert.equal(session.claudeSessionId, null)
  assert.equal(session.identityState?.personaLabel, 'Planner')
  assert.equal(session.lastSessionResetReason, 'idle_timeout:10')
})
