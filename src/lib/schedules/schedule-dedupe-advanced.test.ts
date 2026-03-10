import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findDuplicateSchedule,
  findEquivalentSchedules,
  getScheduleSignatureKey,
  type ScheduleLike,
} from './schedule-dedupe'
import {
  isAgentCreatedSchedule,
  shouldAutoDeleteScheduleAfterTerminalRun,
} from './schedule-origin'
import type { Schedule } from '@/types'

function makeSchedule(partial?: Partial<ScheduleLike>): ScheduleLike {
  const now = Date.now()
  return {
    id: 'sched-1',
    name: 'Test',
    agentId: 'agent-a',
    taskPrompt: 'do something',
    scheduleType: 'interval',
    intervalMs: 3600000,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

function makeFullSchedule(partial?: Partial<Schedule>): Schedule {
  const now = Date.now()
  return {
    id: 'sched-1',
    name: 'Test',
    agentId: 'agent-a',
    taskPrompt: 'do something',
    scheduleType: 'interval',
    intervalMs: 3600000,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 1. Exact duplicate detection
// ---------------------------------------------------------------------------
describe('exact duplicate detection', () => {
  it('matches two schedules with same agentId, same prompt, same cron', () => {
    const schedules: Record<string, ScheduleLike> = {
      existing: makeSchedule({
        id: 'existing',
        agentId: 'agent-a',
        taskPrompt: 'Generate weekly sales report',
        scheduleType: 'cron',
        cron: '0 9 * * 1',
        intervalMs: null,
      }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'generate weekly sales report',
      scheduleType: 'cron',
      cron: '0 9 * * 1',
    })

    assert.ok(result, 'should find exact duplicate')
    assert.equal(result?.id, 'existing')
  })

  it('matches exact duplicate with interval cadence', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        taskPrompt: 'Ping healthcheck endpoint',
        scheduleType: 'interval',
        intervalMs: 300_000,
      }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'ping healthcheck endpoint',
      scheduleType: 'interval',
      intervalMs: 300_000,
    })

    assert.ok(result)
    assert.equal(result?.id, 's1')
  })

  it('matches exact duplicate ignoring extra whitespace in prompt', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        taskPrompt: '  Check   disk  space  ',
        scheduleType: 'interval',
        intervalMs: 60_000,
      }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'check disk space',
      scheduleType: 'interval',
      intervalMs: 60_000,
    })

    assert.ok(result)
    assert.equal(result?.id, 's1')
  })

  it('does not match when agentId differs', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Run tests',
        scheduleType: 'interval',
        intervalMs: 60_000,
      }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-b',
      taskPrompt: 'Run tests',
      scheduleType: 'interval',
      intervalMs: 60_000,
    })

    assert.equal(result, null, 'different agentId should not match')
  })
})

// ---------------------------------------------------------------------------
// 2. Fuzzy matching with reworded prompts
// ---------------------------------------------------------------------------
describe('fuzzy matching with reworded prompts', () => {
  it('fuzzy-matches "Send daily weather report to Slack" vs reworded variant', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send daily weather report to Slack',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'send the weather report daily to slack channel',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(result, 'should fuzzy match reworded prompt within same session')
    assert.equal(result?.id, 's1')
  })

  it('fuzzy-matches when cadence family is the same but exact cadence differs', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send daily weather report to Slack',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        intervalMs: null,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    // interval 86_400_000ms = daily family, cron "0 9 * * *" also resolves to daily
    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'send the weather report daily to slack channel',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(result, 'should fuzzy match across cron/interval with same cadence family')
  })
})

// ---------------------------------------------------------------------------
// 3. Fuzzy matching rejection on low overlap
// ---------------------------------------------------------------------------
describe('fuzzy matching rejection on low overlap', () => {
  it('rejects fuzzy match between unrelated prompts with same cadence', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Check server status',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Send email newsletter',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.equal(result, null, 'completely different prompts should not fuzzy match')
  })

  it('rejects fuzzy match when only one token overlaps', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Monitor database performance metrics',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Deploy database migration scripts',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    // "database" overlaps but coverage/jaccard thresholds not met
    assert.equal(result, null, 'single-token overlap should not pass fuzzy threshold')
  })
})

// ---------------------------------------------------------------------------
// 4. Cross-session scope isolation
// ---------------------------------------------------------------------------
describe('cross-session scope isolation', () => {
  it('session-scoped search does NOT match schedule from different session', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Daily standup summary',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        intervalMs: null,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    // Fuzzy match candidate from a different session — creatorScope sessionId filters it out
    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Standup daily summary notes',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-2',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-2' },
      },
    )

    assert.equal(result, null, 'session scope should prevent cross-session fuzzy match')
  })

  it('agent-scoped search DOES match same-agent schedule from any session (exact match)', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Daily standup summary',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        intervalMs: null,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    // Exact match (same prompt, same cadence) should work without session scope
    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'daily standup summary',
        scheduleType: 'cron',
        cron: '0 9 * * *',
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-2',
      },
    )

    assert.ok(result, 'exact match should work across sessions without session scope')
    assert.equal(result?.id, 's1')
  })

  it('fuzzy match requires session scope to activate', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Daily standup summary notes',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    // Without creatorScope.sessionId, fuzzy matching is off
    const resultNoScope = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Standup daily summary report notes',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
    )

    assert.equal(resultNoScope, null, 'fuzzy match should NOT activate without session scope')

    // With creatorScope.sessionId, fuzzy matching activates
    const resultWithScope = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Standup daily summary report notes',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(resultWithScope, 'fuzzy match should activate with session scope')
  })
})

// ---------------------------------------------------------------------------
// 5. Cadence family matching
// ---------------------------------------------------------------------------
describe('cadence family matching', () => {
  it('interval=900000 (15min) and interval=600000 (10min) are not the same family', () => {
    // 15min is in the "15m" family (tolerance 1min), 10min = 600000 is outside that
    // 10min doesn't match any family bucket — it becomes "interval:10m"
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Monitor CPU temperature readings',
        scheduleType: 'interval',
        intervalMs: 900_000, // 15min
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Monitor CPU temperature readings data',
        scheduleType: 'interval',
        intervalMs: 600_000, // 10min
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.equal(result, null, '15min and 10min are in different cadence families')
  })

  it('two hourly intervals match within same cadence family', () => {
    // 3600000 (60min) and 3_300_000 (55min) — hourly tolerance is 5min
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Fetch latest crypto prices',
        scheduleType: 'interval',
        intervalMs: 3_600_000, // 60min
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Fetch latest crypto prices data',
        scheduleType: 'interval',
        intervalMs: 3_300_000, // 55min — within 5min tolerance of hourly
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(result, 'both are in the "hourly" cadence family')
  })

  it('daily cron and daily interval share the same cadence family', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Summarize server logs',
        scheduleType: 'cron',
        cron: '0 8 * * *', // once a day = ~86400000ms
        intervalMs: null,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Summarize server log entries',
        scheduleType: 'interval',
        intervalMs: 86_400_000, // daily
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(result, 'daily cron and daily interval should be in same family')
  })
})

// ---------------------------------------------------------------------------
// 6. Once schedule window
// ---------------------------------------------------------------------------
describe('once schedule window', () => {
  it('two "once" schedules within 15min window should fuzzy match', () => {
    const baseTime = Date.now() + 3_600_000
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send reminder about meeting',
        scheduleType: 'once',
        intervalMs: null,
        runAt: baseTime,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Send meeting reminder notification',
        scheduleType: 'once',
        runAt: baseTime + 5 * 60 * 1000, // 5 min later
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(result, 'once schedules 5min apart should fuzzy match')
    assert.equal(result?.id, 's1')
  })

  it('two "once" schedules 30min apart should NOT match', () => {
    const baseTime = Date.now() + 3_600_000
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send reminder about meeting',
        scheduleType: 'once',
        intervalMs: null,
        runAt: baseTime,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Send meeting reminder notification',
        scheduleType: 'once',
        runAt: baseTime + 30 * 60 * 1000, // 30 min later — outside 15min window
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.equal(result, null, 'once schedules 30min apart should NOT match')
  })

  it('two "once" schedules with exact same runAt (within 1s) are exact matches', () => {
    const baseTime = Date.now() + 3_600_000
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send reminder about meeting',
        scheduleType: 'once',
        intervalMs: null,
        runAt: baseTime,
      }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'send reminder about meeting',
      scheduleType: 'once',
      runAt: baseTime + 500, // within 1s tolerance
    })

    assert.ok(result, 'once schedules within 1s should exact match')
  })
})

// ---------------------------------------------------------------------------
// 7. Status filtering
// ---------------------------------------------------------------------------
describe('status filtering', () => {
  it('active schedule is matched by default', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1', status: 'active' }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.ok(result)
  })

  it('paused schedule is matched by default', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1', status: 'paused' }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.ok(result)
  })

  it('completed schedule is NOT matched by default', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1', status: 'completed' }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(result, null)
  })

  it('failed schedule is NOT matched by default', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1', status: 'failed' }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(result, null)
  })

  it('completed schedule IS matched when explicitly included', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1', status: 'completed' }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'do something',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
      },
      { includeStatuses: ['active', 'paused', 'completed'] },
    )

    assert.ok(result)
  })
})

// ---------------------------------------------------------------------------
// 8. Signature key stability
// ---------------------------------------------------------------------------
describe('signature key stability', () => {
  it('same inputs produce identical keys', () => {
    const keyA = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: '  Run  daily  backup  ',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })
    const keyB = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'run daily backup',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })

    assert.ok(keyA, 'key should not be empty')
    assert.equal(keyA, keyB, 'normalized equivalent inputs must produce same key')
  })

  it('different prompts produce different keys', () => {
    const keyA = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'Run daily backup',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })
    const keyB = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'Deploy latest release',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })

    assert.notEqual(keyA, keyB, 'different prompts must produce different keys')
  })

  it('different agents produce different keys', () => {
    const keyA = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'Run daily backup',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })
    const keyB = getScheduleSignatureKey({
      agentId: 'agent-b',
      taskPrompt: 'Run daily backup',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })

    assert.notEqual(keyA, keyB, 'different agents must produce different keys')
  })

  it('different cadence produces different keys', () => {
    const keyA = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'Run backup',
      scheduleType: 'cron',
      cron: '0 2 * * *',
    })
    const keyB = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'Run backup',
      scheduleType: 'cron',
      cron: '0 6 * * *',
    })

    assert.notEqual(keyA, keyB, 'different cron cadence must produce different keys')
  })

  it('key format includes all four segments', () => {
    const key = getScheduleSignatureKey({
      agentId: 'agent-x',
      taskPrompt: 'Ping server',
      scheduleType: 'interval',
      intervalMs: 60_000,
    })

    assert.ok(key)
    const parts = key.split('::')
    assert.equal(parts.length, 4, 'key must have 4 double-colon-separated segments')
    assert.equal(parts[0], 'agent-x')
    assert.equal(parts[2], 'interval')
  })
})

// ---------------------------------------------------------------------------
// 9. Equivalent schedules ranking
// ---------------------------------------------------------------------------
describe('equivalent schedules ranking', () => {
  it('returns exact match first, then fuzzy sorted by most recent updatedAt', () => {
    const now = Date.now()
    const schedules: Record<string, ScheduleLike> = {
      fuzzyOld: makeSchedule({
        id: 'fuzzyOld',
        agentId: 'agent-a',
        taskPrompt: 'Summarize server log entries daily',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        updatedAt: now - 200_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
      exact: makeSchedule({
        id: 'exact',
        agentId: 'agent-a',
        taskPrompt: 'Summarize all server logs',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        updatedAt: now - 300_000, // oldest, but exact
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
      fuzzyNew: makeSchedule({
        id: 'fuzzyNew',
        agentId: 'agent-a',
        taskPrompt: 'Summarize server log data entries daily',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        updatedAt: now - 100_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const matches = findEquivalentSchedules(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Summarize all server logs',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(matches.length >= 1, 'should have at least the exact match')

    // The exact match should always be first regardless of updatedAt
    assert.equal(matches[0]?.id, 'exact', 'exact match should come first')

    // If fuzzy matches are present, they should be sorted by updatedAt desc
    const fuzzyMatches = matches.slice(1)
    if (fuzzyMatches.length >= 2) {
      const fuzzyIds = fuzzyMatches.map((m) => m.id)
      assert.equal(fuzzyIds[0], 'fuzzyNew', 'most recent fuzzy should come before older fuzzy')
      assert.equal(fuzzyIds[1], 'fuzzyOld')
    }
  })

  it('findDuplicateSchedule returns the first equivalent (exact over fuzzy)', () => {
    const now = Date.now()
    const schedules: Record<string, ScheduleLike> = {
      fuzzyRecent: makeSchedule({
        id: 'fuzzyRecent',
        agentId: 'agent-a',
        taskPrompt: 'Backup database snapshot tables',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        updatedAt: now,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
      exactOlder: makeSchedule({
        id: 'exactOlder',
        agentId: 'agent-a',
        taskPrompt: 'Backup database tables',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        updatedAt: now - 500_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'backup database tables',
        scheduleType: 'interval',
        intervalMs: 86_400_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.ok(result)
    assert.equal(result?.id, 'exactOlder', 'exact match should win over more recent fuzzy')
  })
})

// ---------------------------------------------------------------------------
// 10. Agent-created vs manual schedules
// ---------------------------------------------------------------------------
describe('agent-created vs manual schedules', () => {
  it('isAgentCreatedSchedule returns true when createdByAgentId is set', () => {
    const schedule = makeFullSchedule({ createdByAgentId: 'agent-a' })
    assert.equal(isAgentCreatedSchedule(schedule), true)
  })

  it('isAgentCreatedSchedule returns false when createdByAgentId is undefined', () => {
    const schedule = makeFullSchedule({ createdByAgentId: undefined })
    assert.equal(isAgentCreatedSchedule(schedule), false)
  })

  it('isAgentCreatedSchedule returns false when createdByAgentId is null', () => {
    const schedule = makeFullSchedule({ createdByAgentId: null })
    assert.equal(isAgentCreatedSchedule(schedule), false)
  })

  it('isAgentCreatedSchedule returns false when createdByAgentId is empty string', () => {
    const schedule = makeFullSchedule({ createdByAgentId: '' })
    assert.equal(isAgentCreatedSchedule(schedule), false)
  })

  it('isAgentCreatedSchedule returns false when createdByAgentId is whitespace', () => {
    const schedule = makeFullSchedule({ createdByAgentId: '   ' })
    assert.equal(isAgentCreatedSchedule(schedule), false)
  })

  it('isAgentCreatedSchedule returns false for null/undefined input', () => {
    assert.equal(isAgentCreatedSchedule(null), false)
    assert.equal(isAgentCreatedSchedule(undefined), false)
  })
})

// ---------------------------------------------------------------------------
// 11. Auto-delete for terminal one-off agent schedules
// ---------------------------------------------------------------------------
describe('auto-delete for terminal one-off agent schedules', () => {
  it('returns true for agent-created once-type schedule', () => {
    const schedule = makeFullSchedule({
      scheduleType: 'once',
      status: 'completed',
      createdByAgentId: 'agent-a',
    })
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(schedule), true)
  })

  it('returns false for agent-created interval schedule', () => {
    const schedule = makeFullSchedule({
      scheduleType: 'interval',
      status: 'completed',
      createdByAgentId: 'agent-a',
    })
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(schedule), false)
  })

  it('returns false for agent-created cron schedule', () => {
    const schedule = makeFullSchedule({
      scheduleType: 'cron',
      status: 'completed',
      createdByAgentId: 'agent-a',
    })
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(schedule), false)
  })

  it('returns false for manual (user-created) once-type schedule', () => {
    const schedule = makeFullSchedule({
      scheduleType: 'once',
      status: 'completed',
      createdByAgentId: undefined,
    })
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(schedule), false)
  })

  it('returns false for null/undefined input', () => {
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(null), false)
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(undefined), false)
  })

  it('returns true regardless of status field (function checks type + creator only)', () => {
    // The function only checks scheduleType=once + createdByAgentId, not status
    const activeOnce = makeFullSchedule({
      scheduleType: 'once',
      status: 'active',
      createdByAgentId: 'agent-a',
    })
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(activeOnce), true)

    const failedOnce = makeFullSchedule({
      scheduleType: 'once',
      status: 'failed',
      createdByAgentId: 'agent-a',
    })
    assert.equal(shouldAutoDeleteScheduleAfterTerminalRun(failedOnce), true)
  })
})

// ---------------------------------------------------------------------------
// 12. Empty prompt handling
// ---------------------------------------------------------------------------
describe('empty prompt handling', () => {
  it('getScheduleSignatureKey returns empty string for empty prompt', () => {
    const key = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: '',
      scheduleType: 'interval',
      intervalMs: 60_000,
    })
    assert.equal(key, '', 'empty prompt should produce empty key')
  })

  it('getScheduleSignatureKey returns empty string for whitespace-only prompt', () => {
    const key = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: '   \t\n  ',
      scheduleType: 'interval',
      intervalMs: 60_000,
    })
    assert.equal(key, '', 'whitespace prompt should produce empty key')
  })

  it('getScheduleSignatureKey returns empty string for null prompt', () => {
    const key = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: null,
      scheduleType: 'interval',
      intervalMs: 60_000,
    })
    assert.equal(key, '', 'null prompt should produce empty key')
  })

  it('getScheduleSignatureKey returns empty string for missing agentId', () => {
    const key = getScheduleSignatureKey({
      agentId: '',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 60_000,
    })
    assert.equal(key, '', 'empty agentId should produce empty key')
  })

  it('findDuplicateSchedule returns null for empty prompt candidate', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1' }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: '',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(result, null)
  })

  it('findDuplicateSchedule returns null for missing agentId candidate', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1' }),
    }

    const result = findDuplicateSchedule(schedules, {
      agentId: '',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(result, null)
  })
})

// ---------------------------------------------------------------------------
// 13. Large batch dedup
// ---------------------------------------------------------------------------
describe('large batch dedup', () => {
  it('correctly groups 50 schedules across 5 agents with prompt variations', () => {
    const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e']
    const basePrompts = [
      'Check server health status',
      'Generate weekly analytics report',
      'Sync database backups offsite',
      'Monitor API response times',
      'Clean up temporary cache files',
    ]

    const schedules: Record<string, ScheduleLike> = {}
    let counter = 0

    // Create 50 schedules: 10 per agent, 2 variations per base prompt
    for (const agentId of agents) {
      for (let i = 0; i < basePrompts.length; i++) {
        for (let variant = 0; variant < 2; variant++) {
          const id = `sched-${counter++}`
          schedules[id] = makeSchedule({
            id,
            agentId,
            taskPrompt: variant === 0 ? basePrompts[i] : `${basePrompts[i]} now`,
            scheduleType: 'interval',
            intervalMs: 3_600_000,
            updatedAt: Date.now() - counter * 1000,
          })
        }
      }
    }

    assert.equal(Object.keys(schedules).length, 50, 'should have 50 schedules')

    // For each agent, try to find a duplicate of the base prompt — should find exact match
    for (const agentId of agents) {
      const result = findDuplicateSchedule(schedules, {
        agentId,
        taskPrompt: 'check server health status',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
      })

      assert.ok(result, `should find exact duplicate for ${agentId}`)
      assert.equal(result?.agentId, agentId, 'match should be from the same agent')
    }

    // Cross-agent: should NOT match agent-a prompt against agent-b schedule
    const crossResult = findDuplicateSchedule(schedules, {
      agentId: 'agent-nonexistent',
      taskPrompt: 'check server health status',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(crossResult, null, 'no schedule for non-existent agent')
  })

  it('findEquivalentSchedules returns multiple matches within same agent', () => {
    const schedules: Record<string, ScheduleLike> = {}
    const now = Date.now()

    // Create several schedules with the same agent and exact same prompt
    for (let i = 0; i < 5; i++) {
      const id = `dup-${i}`
      schedules[id] = makeSchedule({
        id,
        agentId: 'agent-a',
        taskPrompt: 'Run integration tests',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        status: 'active',
        updatedAt: now - i * 10_000,
      })
    }

    const matches = findEquivalentSchedules(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'run integration tests',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(matches.length, 5, 'should return all 5 exact matches')

    // Verify sorted by updatedAt descending
    for (let i = 0; i < matches.length - 1; i++) {
      const current = matches[i].updatedAt ?? matches[i].createdAt ?? 0
      const next = matches[i + 1].updatedAt ?? matches[i + 1].createdAt ?? 0
      assert.ok(current >= next, 'matches should be sorted by updatedAt desc')
    }
  })
})

// ---------------------------------------------------------------------------
// 14. Cron vs interval differentiation
// ---------------------------------------------------------------------------
describe('cron vs interval differentiation', () => {
  it('same prompt with cron vs interval are NOT exact matches', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send status report',
        scheduleType: 'cron',
        cron: '0 * * * *', // every hour
        intervalMs: null,
      }),
    }

    // Same prompt but interval type — exact match requires same scheduleType
    const result = findDuplicateSchedule(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'send status report',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(result, null, 'cron and interval with same prompt should NOT exact match')
  })

  it('cron and interval of same family CAN fuzzy match with session scope', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send status report summary',
        scheduleType: 'cron',
        cron: '0 * * * *', // every hour
        intervalMs: null,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Send status report data summary',
        scheduleType: 'interval',
        intervalMs: 3_600_000, // hourly
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    // sameCadenceFamily considers cron resolved to hourly interval = same family
    assert.ok(result, 'cron hourly and interval hourly should fuzzy match via cadence family')
  })

  it('once vs interval NEVER match even with session scope', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'Send status report summary data',
        scheduleType: 'once',
        intervalMs: null,
        runAt: Date.now() + 60_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        agentId: 'agent-a',
        taskPrompt: 'Send status report summary data entries',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
        createdByAgentId: 'agent-a',
        createdInSessionId: 'sess-1',
      },
      {
        creatorScope: { agentId: 'agent-a', sessionId: 'sess-1' },
      },
    )

    assert.equal(result, null, 'once and interval should never match')
  })
})

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  it('ignoreId option prevents self-matching', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1' }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'do something',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
      },
    )

    assert.equal(result, null, 'candidate id in ignoreId should prevent self-match')
  })

  it('explicit ignoreId overrides candidate id', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({ id: 's1' }),
      s2: makeSchedule({ id: 's2' }),
    }

    const result = findDuplicateSchedule(
      schedules,
      {
        id: 's1',
        agentId: 'agent-a',
        taskPrompt: 'do something',
        scheduleType: 'interval',
        intervalMs: 3_600_000,
      },
      { ignoreId: 's2' },
    )

    // s2 is ignored via ignoreId, s1 is NOT ignored (explicit ignoreId overrides candidate.id)
    assert.ok(result)
    assert.equal(result?.id, 's1')
  })

  it('empty schedule map returns null', () => {
    const result = findDuplicateSchedule({}, {
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.equal(result, null)
  })

  it('findEquivalentSchedules returns empty array for no matches', () => {
    const schedules: Record<string, ScheduleLike> = {
      s1: makeSchedule({
        id: 's1',
        agentId: 'agent-b',
        taskPrompt: 'completely different thing',
      }),
    }

    const matches = findEquivalentSchedules(schedules, {
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: 3_600_000,
    })

    assert.deepEqual(matches, [])
  })

  it('getScheduleSignatureKey handles interval with no intervalMs gracefully', () => {
    const key = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'interval',
      intervalMs: null,
    })

    // sameCadence returns false for interval with null intervalMs, so key is empty
    assert.equal(key, '', 'interval schedule without intervalMs should produce empty key')
  })

  it('getScheduleSignatureKey handles cron with no cron string gracefully', () => {
    const key = getScheduleSignatureKey({
      agentId: 'agent-a',
      taskPrompt: 'do something',
      scheduleType: 'cron',
      cron: '',
    })

    assert.equal(key, '', 'cron schedule without cron string should produce empty key')
  })
})
