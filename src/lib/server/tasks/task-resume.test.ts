import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BoardTask, Session } from '@/types'
import { resolveReusableTaskSessionId, resolveTaskResumeContext } from '@/lib/server/tasks/task-resume'

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

describe('task resume context', () => {
  it('does not reuse blocker resume handles for workflow dependency tasks', () => {
    const blocker = makeTask({
      id: 'worker-1',
      title: 'Worker',
      sessionId: 'session-worker',
    })
    const fanIn = makeTask({
      id: 'fan-in',
      title: 'Fan-in',
      blockedBy: ['worker-1'],
      workflow: { bundleId: 'workflow-1', bundleTaskKey: 'fan_in' },
    })
    const sessions: Record<string, Partial<Session>> = {
      'session-worker': {
        id: 'session-worker',
        codexThreadId: 'codex-worker-thread',
      },
    }

    const context = resolveTaskResumeContext(fanIn, { 'worker-1': blocker, 'fan-in': fanIn }, sessions)

    assert.equal(context, null)
  })

  it('does not reuse blocker resume handles once upstream results are hydrated', () => {
    const blocker = makeTask({
      id: 'worker-1',
      title: 'Worker',
      sessionId: 'session-worker',
    })
    const fanIn = makeTask({
      id: 'fan-in',
      title: 'Fan-in',
      blockedBy: ['worker-1'],
      upstreamResults: [{
        taskId: 'worker-1',
        taskTitle: 'Worker',
        agentId: 'agent-1',
        resultPreview: 'WORKER_OK',
      }],
    })
    const sessions: Record<string, Partial<Session>> = {
      'session-worker': {
        id: 'session-worker',
        codexThreadId: 'codex-worker-thread',
      },
    }

    const context = resolveTaskResumeContext(fanIn, { 'worker-1': blocker, 'fan-in': fanIn }, sessions)

    assert.equal(context, null)
  })

  it('does not reuse blocker sessions once upstream results are hydrated', () => {
    const blocker = makeTask({
      id: 'worker-1',
      title: 'Worker',
      sessionId: 'session-worker',
    })
    const fanIn = makeTask({
      id: 'fan-in',
      title: 'Fan-in',
      blockedBy: ['worker-1'],
      upstreamResults: [{
        taskId: 'worker-1',
        taskTitle: 'Worker',
        agentId: 'agent-1',
        resultPreview: 'WORKER_OK',
      }],
    })
    const sessions: Record<string, Session> = {
      'session-worker': {
        id: 'session-worker',
        agentId: 'agent-1',
        title: 'Worker',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        cwd: '/tmp',
        user: '',
        codexThreadId: 'codex-worker-thread',
      },
    }

    const sessionId = resolveReusableTaskSessionId(fanIn, { 'worker-1': blocker, 'fan-in': fanIn }, sessions)

    assert.equal(sessionId, '')
  })
})
