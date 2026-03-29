import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatSituationalAwareness,
  timeAgo,
  type SituationalAwarenessData,
} from '@/lib/server/chat-execution/situational-awareness'
import type { BoardTask, Schedule, SupervisorIncident, SessionRunRecord } from '@/types'

const NOW = 1_710_500_000_000 // fixed timestamp for deterministic tests

function emptyData(): SituationalAwarenessData {
  return { tasks: [], schedules: [], failedRuns: [], incidents: [], now: NOW }
}

function makeTask(overrides: Partial<BoardTask> & { id: string; title: string; status: string; agentId: string }): BoardTask {
  return { description: '', createdAt: NOW, updatedAt: NOW, ...overrides } as BoardTask
}

function makeSchedule(overrides: Partial<Schedule> & { id: string; name: string; agentId: string }): Schedule {
  return { taskPrompt: '', scheduleType: 'cron' as const, status: 'active' as const, ...overrides } as Schedule
}

function makeRun(overrides: Partial<SessionRunRecord> & { id: string; sessionId: string }): SessionRunRecord {
  return {
    source: 'heartbeat',
    internal: false,
    mode: 'normal',
    status: 'failed' as const,
    messagePreview: '',
    queuedAt: NOW - 7_200_000,
    ...overrides,
  } as SessionRunRecord
}

function makeIncident(overrides: Partial<SupervisorIncident> & { id: string; agentId: string }): SupervisorIncident {
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    source: 'supervisor',
    kind: 'run_error' as const,
    severity: 'warning' as const,
    summary: 'test incident',
    createdAt: NOW - 3_600_000,
    ...overrides,
  } as SupervisorIncident
}

describe('timeAgo', () => {
  it('formats seconds as just now', () => {
    assert.equal(timeAgo(NOW - 30_000, NOW), 'just now')
  })

  it('formats minutes', () => {
    assert.equal(timeAgo(NOW - 5 * 60_000, NOW), '5m ago')
  })

  it('formats hours', () => {
    assert.equal(timeAgo(NOW - 3 * 3_600_000, NOW), '3h ago')
  })

  it('formats days', () => {
    assert.equal(timeAgo(NOW - 2 * 86_400_000, NOW), '2d ago')
  })
})

describe('formatSituationalAwareness', () => {
  it('returns empty string when agent has no tasks, schedules, failures, or mission', () => {
    const result = formatSituationalAwareness(emptyData())
    assert.equal(result, '')
  })

  it('builds tasks section for agent with active tasks', () => {
    const data = emptyData()
    data.tasks = [
      makeTask({ id: 't1', title: 'Deploy staging hotfix', status: 'running', agentId: 'a1', createdAt: NOW - 2 * 3_600_000 }),
      makeTask({ id: 't2', title: 'Review PR #147', status: 'queued', agentId: 'a1', createdAt: NOW - 5 * 3_600_000 }),
      makeTask({ id: 't3', title: 'Completed task', status: 'completed', agentId: 'a1' }),
    ]

    const result = formatSituationalAwareness(data)

    assert.ok(result.includes('## My Situational Awareness'))
    assert.ok(result.includes('### Active Tasks (2)'))
    assert.ok(result.includes('[running] Deploy staging hotfix'))
    assert.ok(result.includes('[queued] Review PR #147'))
    assert.ok(!result.includes('Completed task'))
  })

  it('sorts tasks by status priority: running > queued > backlog', () => {
    const data = emptyData()
    data.tasks = [
      makeTask({ id: 't1', title: 'Backlog item', status: 'backlog', agentId: 'a1' }),
      makeTask({ id: 't2', title: 'Running item', status: 'running', agentId: 'a1' }),
      makeTask({ id: 't3', title: 'Queued item', status: 'queued', agentId: 'a1' }),
    ]

    const result = formatSituationalAwareness(data)
    const lines = result.split('\n').filter((l) => l.startsWith('- ['))

    assert.ok(lines[0].includes('[running]'))
    assert.ok(lines[1].includes('[queued]'))
    assert.ok(lines[2].includes('[backlog]'))
  })

  it('limits tasks to 5', () => {
    const data = emptyData()
    for (let i = 0; i < 8; i++) {
      data.tasks.push(makeTask({ id: `t${i}`, title: `Task ${i}`, status: 'queued', agentId: 'a1' }))
    }

    const result = formatSituationalAwareness(data)
    assert.ok(result.includes('### Active Tasks (5)'))
  })

  it('builds schedules section for active schedules', () => {
    const data = emptyData()
    data.schedules = [
      makeSchedule({ id: 's1', name: 'Daily standup report', agentId: 'a1', nextRunAt: NOW + 35 * 60_000, frequency: 'daily at 09:00' }),
    ]

    const result = formatSituationalAwareness(data)

    assert.ok(result.includes('### My Schedule'))
    assert.ok(result.includes('Daily standup report'))
    assert.ok(result.includes('daily at 09:00'))
  })

  it('skips paused schedules', () => {
    const data = emptyData()
    data.schedules = [
      makeSchedule({ id: 's1', name: 'Paused sched', agentId: 'a1', status: 'paused' as const }),
    ]

    const result = formatSituationalAwareness(data)
    assert.equal(result, '')
  })

  it('builds failures section from runs and incidents', () => {
    const data = emptyData()
    data.failedRuns = [
      makeRun({ id: 'r1', sessionId: 'sess-1', endedAt: NOW - 3 * 3_600_000, error: 'Provider timeout on ollama/llama3' }),
    ]
    data.incidents = [
      makeIncident({ id: 'inc-1', agentId: 'a1', kind: 'no_progress' as const, summary: 'Stuck in tool loop', remediation: 'Retry with different approach', createdAt: NOW - 24 * 3_600_000 }),
    ]

    const result = formatSituationalAwareness(data)

    assert.ok(result.includes('### Recent Failures'))
    assert.ok(result.includes('Provider timeout'))
    assert.ok(result.includes('no_progress'))
    assert.ok(result.includes('-- remedy: Retry with different approach'))
  })

  it('filters out failures older than 72 hours', () => {
    const data = emptyData()
    data.failedRuns = [
      makeRun({ id: 'r1', sessionId: 'sess-1', endedAt: NOW - 100 * 3_600_000, error: 'Old error' }),
    ]

    const result = formatSituationalAwareness(data)
    assert.equal(result, '')
  })

  it('deduplicates failures within 5s of each other', () => {
    const ts = NOW - 3_600_000
    const data = emptyData()
    data.failedRuns = [
      makeRun({ id: 'r1', sessionId: 'sess-1', endedAt: ts, error: 'Same error from run' }),
    ]
    data.incidents = [
      makeIncident({ id: 'inc-1', agentId: 'a1', summary: 'Same error from incident', createdAt: ts + 2000 }),
    ]

    const result = formatSituationalAwareness(data)

    assert.ok(result.includes('### Recent Failures'))
    const failureLines = result.split('\n').filter((l) => l.startsWith('- ['))
    assert.equal(failureLines.length, 1)
  })

  it('keeps failures that are more than 5s apart', () => {
    const data = emptyData()
    data.failedRuns = [
      makeRun({ id: 'r1', sessionId: 'sess-1', endedAt: NOW - 3_600_000, error: 'Error one' }),
      makeRun({ id: 'r2', sessionId: 'sess-1', endedAt: NOW - 7_200_000, error: 'Error two' }),
    ]

    const result = formatSituationalAwareness(data)
    const failureLines = result.split('\n').filter((l) => l.startsWith('- ['))
    assert.equal(failureLines.length, 2)
  })

  it('produces all sections within token budget', () => {
    const data = emptyData()
    for (let i = 0; i < 5; i++) {
      data.tasks.push(makeTask({
        id: `t${i}`,
        title: `Task number ${i} with a reasonably long title for testing`,
        status: i < 2 ? 'running' : 'queued',
        agentId: 'a1',
        createdAt: NOW - i * 3_600_000,
      }))
    }
    for (let i = 0; i < 3; i++) {
      data.schedules.push(makeSchedule({
        id: `s${i}`,
        name: `Schedule ${i}`,
        agentId: 'a1',
        nextRunAt: NOW + (i + 1) * 3_600_000,
        frequency: 'daily',
      }))
    }
    data.failedRuns.push(makeRun({ id: 'r1', sessionId: 'sess-1', endedAt: NOW - 3_600_000, error: 'Test failure' }))

    const result = formatSituationalAwareness(data)

    assert.ok(result.includes('## My Situational Awareness'))
    assert.ok(result.includes('### Active Tasks'))
    assert.ok(result.includes('### Recent Failures'))
    assert.ok(result.includes('### My Schedule'))
    assert.ok(result.length <= 3200, `Block is ${result.length} chars, should be <= 3200`)
  })

  it('truncates lowest-priority sections when exceeding budget', () => {
    const data = emptyData()
    // Fill tasks with long titles
    for (let i = 0; i < 5; i++) {
      data.tasks.push(makeTask({ id: `t${i}`, title: 'A'.repeat(80), status: 'running', agentId: 'a1', createdAt: NOW - i * 3_600_000 }))
    }
    // Fill failures
    for (let i = 0; i < 3; i++) {
      data.failedRuns.push(makeRun({ id: `r${i}`, sessionId: 'sess-1', endedAt: NOW - (i + 1) * 3_600_000, error: 'E'.repeat(120) }))
    }
    // Fill schedules
    for (let i = 0; i < 3; i++) {
      data.schedules.push(makeSchedule({ id: `s${i}`, name: 'S'.repeat(60), agentId: 'a1', nextRunAt: NOW + 3_600_000, frequency: 'daily' }))
    }

    const result = formatSituationalAwareness(data)

    assert.ok(result.length <= 3200, `Block is ${result.length} chars, should be <= 3200`)
    // Highest-priority section should still be present
    assert.ok(result.includes('### Active Tasks'))
  })
})
