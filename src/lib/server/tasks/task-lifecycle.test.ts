import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BoardTask, Schedule } from '@/types'

import {
  buildBoardTask,
  didTaskValidationChange,
  markInvalidCompletedTaskFailed,
  markValidatedTaskCompleted,
  prepareScheduledTaskRun,
  resetTaskForRerun,
} from '@/lib/server/tasks/task-lifecycle'

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'task-1',
    title: 'Example Task',
    description: 'Do the work',
    status: 'backlog',
    agentId: 'agent-1',
    sessionId: null,
    result: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'Nightly backup',
    agentId: 'agent-1',
    taskPrompt: 'Run nightly backup',
    scheduleType: 'cron',
    cron: '0 0 * * *',
    status: 'active',
    runNumber: 2,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('task lifecycle helpers', () => {
  it('buildBoardTask applies shared defaults and preserves seed metadata', () => {
    const task = buildBoardTask({
      id: 'task-build',
      title: 'Build',
      description: 'Compile project',
      agentId: 'agent-1',
      now: 123,
      seed: {
        comments: [],
        sourceType: 'manual',
      },
    })

    assert.equal(task.id, 'task-build')
    assert.equal(task.status, 'backlog')
    assert.equal(task.sessionId, null)
    assert.equal(task.result, null)
    assert.equal(task.createdAt, 123)
    assert.equal(task.sourceType, 'manual')
  })

  it('resetTaskForRerun clears terminal fields and rolls stats forward', () => {
    const task = makeTask({
      status: 'completed',
      result: 'done',
      error: 'old error',
      sessionId: 'session-1',
      completionReportPath: 'report.md',
      outputFiles: ['a.txt'],
      artifacts: [{ url: '/x', type: 'file', filename: 'x.txt' }],
      attempts: 3,
      retryScheduledAt: 10,
      deadLetteredAt: 20,
      validation: { ok: true, reasons: [], checkedAt: 5 },
      runNumber: 1,
      totalRuns: 4,
      totalCompleted: 2,
    })

    resetTaskForRerun(task, {
      title: '[Sched] Nightly backup (run #2)',
      now: 99,
      runNumber: 2,
    })

    assert.equal(task.status, 'backlog')
    assert.equal(task.title, '[Sched] Nightly backup (run #2)')
    assert.equal(task.result, null)
    assert.equal(task.error, null)
    assert.equal(task.sessionId, null)
    assert.equal(task.completionReportPath, null)
    assert.equal(task.completedAt, null)
    assert.equal(task.attempts, 0)
    assert.equal(task.retryScheduledAt, null)
    assert.equal(task.deadLetteredAt, null)
    assert.equal(task.validation, null)
    assert.equal(task.totalRuns, 5)
    assert.equal(task.totalCompleted, 3)
    assert.equal(task.runNumber, 2)
  })

  it('prepareScheduledTaskRun creates a schedule-backed task when no reusable task exists', () => {
    const schedule = makeSchedule({
      createdInSessionId: 'session-1',
      createdByAgentId: 'agent-owner',
      followupConnectorId: 'connector-1',
    })
    const tasks: Record<string, BoardTask> = {}

    const { taskId, task } = prepareScheduledTaskRun({
      schedule,
      tasks,
      now: 200,
      scheduleSignature: 'sig-1',
    })

    assert.equal(taskId, task.id)
    assert.equal(task.sourceType, 'schedule')
    assert.equal(task.sourceScheduleId, schedule.id)
    assert.equal(task.sourceScheduleKey, 'sig-1')
    assert.equal(task.createdInSessionId, 'session-1')
    assert.equal(task.followupConnectorId, 'connector-1')
    assert.equal(schedule.linkedTaskId, taskId)
    assert.equal(tasks[taskId], task)
  })

  it('prepareScheduledTaskRun reuses and resets a terminal linked task', () => {
    const existing = makeTask({
      id: 'linked-task',
      status: 'failed',
      result: 'failed before',
      runNumber: 1,
    })
    const tasks: Record<string, BoardTask> = { 'linked-task': existing }
    const schedule = makeSchedule({
      linkedTaskId: 'linked-task',
      runNumber: 7,
    })

    const { taskId, task } = prepareScheduledTaskRun({
      schedule,
      tasks,
      now: 300,
      scheduleSignature: 'sig-2',
    })

    assert.equal(taskId, 'linked-task')
    assert.equal(task, existing)
    assert.equal(task.status, 'backlog')
    assert.equal(task.runNumber, 7)
    assert.equal(task.result, null)
  })

  it('markValidatedTaskCompleted preserves or sets completedAt as requested', () => {
    const task = makeTask({ status: 'completed', completedAt: 10, error: 'nope' })
    markValidatedTaskCompleted(task, { now: 50, preserveCompletedAt: true })
    assert.equal(task.completedAt, 10)
    assert.equal(task.error, null)

    markValidatedTaskCompleted(task, { now: 75 })
    assert.equal(task.completedAt, 75)
  })

  it('markInvalidCompletedTaskFailed records failure state and comment', () => {
    const task = makeTask({ status: 'completed' })
    markInvalidCompletedTaskFailed(task, {
      ok: false,
      reasons: ['Missing evidence'],
      checkedAt: 20,
    }, {
      now: 30,
      comment: {
        author: 'System',
        text: 'Validation failed.',
      },
    })

    assert.equal(task.status, 'failed')
    assert.equal(task.completedAt, null)
    assert.match(task.error || '', /Completion validation failed/)
    assert.equal(task.comments?.[0]?.author, 'System')
  })

  it('didTaskValidationChange compares both status and reasons', () => {
    assert.equal(didTaskValidationChange(null, { ok: true, reasons: [], checkedAt: 1 }), true)
    assert.equal(didTaskValidationChange(
      { ok: true, reasons: [], checkedAt: 1 },
      { ok: true, reasons: [], checkedAt: 2 },
    ), false)
    assert.equal(didTaskValidationChange(
      { ok: true, reasons: [], checkedAt: 1 },
      { ok: false, reasons: ['x'], checkedAt: 2 },
    ), true)
  })
})
