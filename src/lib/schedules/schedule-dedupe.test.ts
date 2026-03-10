import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findDuplicateSchedule, findEquivalentSchedules, getScheduleSignatureKey, type ScheduleLike } from './schedule-dedupe'

test('findDuplicateSchedule matches active interval schedules with normalized prompts', () => {
  const schedules: Record<string, ScheduleLike> = {
    a1: {
      id: 'a1',
      agentId: 'assistant',
      taskPrompt: 'Take   a screenshot of Wikipedia homepage',
      scheduleType: 'interval',
      intervalMs: 60_000,
      status: 'active',
      createdAt: 1,
    },
  }

  const duplicate = findDuplicateSchedule(schedules, {
    agentId: 'assistant',
    taskPrompt: 'take a screenshot of wikipedia homepage',
    scheduleType: 'interval',
    intervalMs: 60_000,
  })

  assert.ok(duplicate)
  assert.equal(duplicate?.id, 'a1')
})

test('findDuplicateSchedule ignores completed/failed schedules by default', () => {
  const schedules: Record<string, ScheduleLike> = {
    done1: {
      id: 'done1',
      agentId: 'assistant',
      taskPrompt: 'Run report',
      scheduleType: 'interval',
      intervalMs: 300_000,
      status: 'completed',
      createdAt: 1,
    },
    fail1: {
      id: 'fail1',
      agentId: 'assistant',
      taskPrompt: 'Run report',
      scheduleType: 'interval',
      intervalMs: 300_000,
      status: 'failed',
      createdAt: 2,
    },
  }

  const duplicate = findDuplicateSchedule(schedules, {
    agentId: 'assistant',
    taskPrompt: 'run report',
    scheduleType: 'interval',
    intervalMs: 300_000,
  })

  assert.equal(duplicate, null)
})

test('getScheduleSignatureKey is stable for equivalent schedules', () => {
  const keyA = getScheduleSignatureKey({
    agentId: 'assistant',
    taskPrompt: '  Check  status ',
    scheduleType: 'cron',
    cron: '*/5 * * * *',
  })
  const keyB = getScheduleSignatureKey({
    agentId: 'assistant',
    taskPrompt: 'check status',
    scheduleType: 'cron',
    cron: '*/5 * * * *',
  })
  const keyC = getScheduleSignatureKey({
    agentId: 'assistant',
    taskPrompt: 'check status',
    scheduleType: 'cron',
    cron: '*/10 * * * *',
  })

  assert.ok(keyA)
  assert.equal(keyA, keyB)
  assert.notEqual(keyA, keyC)
})

test('findDuplicateSchedule fuzzy-matches same-session recurring reminders with different wording and cadence shape', () => {
  const schedules: Record<string, ScheduleLike> = {
    daily1: {
      id: 'daily1',
      agentId: 'assistant',
      taskPrompt: 'Daily check for updates on US-Iran tensions',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      status: 'active',
      createdByAgentId: 'assistant',
      createdInSessionId: 'session-1',
      createdAt: 1,
    },
  }

  const duplicate = findDuplicateSchedule(schedules, {
    agentId: 'assistant',
    taskPrompt: 'Periodic update check for US-Iran tensions',
    scheduleType: 'interval',
    intervalMs: 86_400_000,
    createdByAgentId: 'assistant',
    createdInSessionId: 'session-1',
  }, {
    creatorScope: {
      agentId: 'assistant',
      sessionId: 'session-1',
    },
  })

  assert.ok(duplicate)
  assert.equal(duplicate?.id, 'daily1')
})

test('findEquivalentSchedules does not fuzzy-match across sessions', () => {
  const schedules: Record<string, ScheduleLike> = {
    daily1: {
      id: 'daily1',
      agentId: 'assistant',
      taskPrompt: 'Daily check for updates on US-Iran tensions',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      status: 'active',
      createdByAgentId: 'assistant',
      createdInSessionId: 'session-1',
      createdAt: 1,
    },
  }

  const matches = findEquivalentSchedules(schedules, {
    agentId: 'assistant',
    taskPrompt: 'Periodic update check for US-Iran tensions',
    scheduleType: 'interval',
    intervalMs: 86_400_000,
    createdByAgentId: 'assistant',
    createdInSessionId: 'session-2',
  }, {
    creatorScope: {
      agentId: 'assistant',
      sessionId: 'session-2',
    },
  })

  assert.deepEqual(matches, [])
})
