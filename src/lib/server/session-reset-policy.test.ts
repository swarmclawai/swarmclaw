import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

let mod: typeof import('@/lib/server/session-reset-policy')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/session-reset-policy')
})

after(() => {
  delete process.env.SWARMCLAW_BUILD_MODE
})

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('session-reset-policy', () => {
  // ---- inferSessionResetType ----
  describe('inferSessionResetType', () => {
    it('delegated session → main', () => {
      assert.equal(mod.inferSessionResetType({ sessionType: 'delegated' } as never), 'main')
    })

    it('orchestrated (legacy) session → main', () => {
      assert.equal(mod.inferSessionResetType({ sessionType: 'orchestrated' } as never), 'main')
    })

    it('group session → group', () => {
      assert.equal(mod.inferSessionResetType(null, { isGroup: true }), 'group')
    })

    it('thread session → thread', () => {
      assert.equal(mod.inferSessionResetType(null, { threadId: 'th-1' }), 'thread')
    })

    it('regular session → direct', () => {
      assert.equal(mod.inferSessionResetType(makeSession() as never), 'direct')
    })
  })

  // ---- resolveSessionResetPolicy ----
  describe('resolveSessionResetPolicy', () => {
    it('default policy for direct type', () => {
      const policy = mod.resolveSessionResetPolicy({ resetType: 'direct' })
      assert.equal(policy.type, 'direct')
      assert.equal(policy.mode, 'idle')
      assert.equal(policy.idleTimeoutSec, 12 * 60 * 60)
      assert.equal(policy.maxAgeSec, 7 * 24 * 60 * 60)
      assert.equal(policy.dailyResetAt, null)
    })

    it('default policy for main type (daily mode)', () => {
      const policy = mod.resolveSessionResetPolicy({ resetType: 'main' })
      assert.equal(policy.type, 'main')
      assert.equal(policy.mode, 'daily')
      assert.equal(policy.dailyResetAt, '04:00')
    })

    it('default policy for group type', () => {
      const policy = mod.resolveSessionResetPolicy({ resetType: 'group' })
      assert.equal(policy.type, 'group')
      assert.equal(policy.idleTimeoutSec, 6 * 60 * 60)
    })

    it('default policy for thread type', () => {
      const policy = mod.resolveSessionResetPolicy({ resetType: 'thread' })
      assert.equal(policy.type, 'thread')
      assert.equal(policy.idleTimeoutSec, 4 * 60 * 60)
    })

    it('custom override takes precedence', () => {
      const policy = mod.resolveSessionResetPolicy({
        resetType: 'direct',
        overrides: { sessionIdleTimeoutSec: 3600, sessionResetMode: 'daily', sessionDailyResetAt: '06:00' },
      })
      assert.equal(policy.idleTimeoutSec, 3600)
      assert.equal(policy.mode, 'daily')
      assert.equal(policy.dailyResetAt, '06:00')
    })

    it('session field overrides agent/settings', () => {
      const policy = mod.resolveSessionResetPolicy({
        resetType: 'direct',
        session: { sessionIdleTimeoutSec: 1800 } as never,
        agent: { sessionIdleTimeoutSec: 7200 } as never,
      })
      assert.equal(policy.idleTimeoutSec, 1800)
    })

    it('isolated mode is preserved and not replaced by fallback', () => {
      const policy = mod.resolveSessionResetPolicy({
        resetType: 'direct',
        session: { sessionResetMode: 'isolated' } as never,
      })
      assert.equal(policy.mode, 'isolated')
    })

    it('isolated mode from agent config is preserved', () => {
      const policy = mod.resolveSessionResetPolicy({
        resetType: 'direct',
        agent: { sessionResetMode: 'isolated' } as never,
      })
      assert.equal(policy.mode, 'isolated')
    })
  })

  // ---- evaluateSessionFreshness ----
  describe('evaluateSessionFreshness', () => {
    it('no session → fresh', () => {
      const policy = mod.resolveSessionResetPolicy({ resetType: 'direct' })
      const result = mod.evaluateSessionFreshness({ policy })
      assert.equal(result.fresh, true)
    })

    it('empty messages → fresh', () => {
      const policy = mod.resolveSessionResetPolicy({ resetType: 'direct' })
      const session = makeSession({ messages: [], createdAt: Date.now(), lastActiveAt: Date.now() })
      const result = mod.evaluateSessionFreshness({ session: session as never, policy })
      assert.equal(result.fresh, true)
    })

    it('within idle timeout → fresh', () => {
      const now = Date.now()
      const policy = mod.resolveSessionResetPolicy({ resetType: 'direct' })
      const session = makeSession({ createdAt: now - 1000, lastActiveAt: now - 1000 })
      const result = mod.evaluateSessionFreshness({ session: session as never, policy, now })
      assert.equal(result.fresh, true)
    })

    it('past idle timeout → stale', () => {
      const policy = mod.resolveSessionResetPolicy({
        session: makeSession({
          createdAt: 0,
          lastActiveAt: 0,
          sessionIdleTimeoutSec: 10,
          sessionMaxAgeSec: 60,
        }) as never,
      })
      const session = makeSession({ createdAt: 0, lastActiveAt: 0 })
      const result = mod.evaluateSessionFreshness({ session: session as never, policy, now: 11_000 })
      assert.equal(result.fresh, false)
      assert.ok(result.reason?.startsWith('idle_timeout'))
    })

    it('past max age → stale', () => {
      const now = Date.now()
      const policy = mod.resolveSessionResetPolicy({ resetType: 'direct' })
      const session = makeSession({
        createdAt: now - 8 * 24 * 60 * 60 * 1000,
        lastActiveAt: now - 1000,
      })
      const result = mod.evaluateSessionFreshness({ session: session as never, policy, now })
      assert.equal(result.fresh, false)
      assert.ok(result.reason?.startsWith('max_age'))
    })

    it('daily boundary key changes at midnight', () => {
      const session = makeSession({
        createdAt: Date.parse('2026-03-04T00:00:00.000Z'),
        lastActiveAt: Date.parse('2026-03-05T03:30:00.000Z'),
      })
      const policy = mod.resolveSessionResetPolicy({
        session: {
          ...session,
          sessionResetMode: 'daily',
          sessionDailyResetAt: '04:00',
          sessionResetTimezone: 'UTC',
          sessionMaxAgeSec: 999999,
          sessionIdleTimeoutSec: 0,
        } as never,
      })
      const result = mod.evaluateSessionFreshness({
        session: session as never,
        policy,
        now: Date.parse('2026-03-05T10:00:00.000Z'),
      })
      assert.equal(result.fresh, false)
      assert.equal(result.reason, 'daily_reset:04:00')
    })
  })

  // ---- resetSessionRuntime ----
  describe('resetSessionRuntime', () => {
    it('clears transient state but preserves identity state', () => {
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

      const cleared = mod.resetSessionRuntime(session as never, 'idle_timeout:10', { now: 1000 })

      assert.equal(cleared, 1)
      assert.deepEqual(session.messages, [])
      assert.equal(session.claudeSessionId, null)
      assert.equal((session as Record<string, unknown>).lastSessionResetReason, 'idle_timeout:10')
    })
  })
})
