import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BoardTask } from '@/types'
import { cascadeUnblock, hydrateUpstreamResults } from '@/lib/server/dag-validation'

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

describe('dependency upstream result hydration', () => {
  it('hydrates completed blocker output before a dependent task runs', () => {
    const blocker = makeTask({
      id: 'worker-1',
      title: 'Worker output',
      status: 'completed',
      result: 'WORKER_OK\nUseful findings.',
    })
    const fanIn = makeTask({
      id: 'fan-in',
      title: 'Fan-in review',
      blockedBy: ['worker-1'],
    })
    const tasks: Record<string, BoardTask> = {
      'worker-1': blocker,
      'fan-in': fanIn,
    }

    const changed = hydrateUpstreamResults(fanIn, tasks)

    assert.equal(changed, true)
    assert.equal(fanIn.upstreamResults?.[0]?.taskId, 'worker-1')
    assert.equal(fanIn.upstreamResults?.[0]?.taskTitle, 'Worker output')
    assert.match(fanIn.upstreamResults?.[0]?.resultPreview || '', /WORKER_OK/)
  })

  it('populates upstream output when cascade unblocks a backlog fan-in task', () => {
    const blocker = makeTask({
      id: 'worker-1',
      title: 'Worker output',
      status: 'completed',
      result: 'WORKER_OK\nUseful findings.',
      blocks: ['fan-in'],
    })
    const fanIn = makeTask({
      id: 'fan-in',
      title: 'Fan-in review',
      blockedBy: ['worker-1'],
    })
    const tasks: Record<string, BoardTask> = {
      'worker-1': blocker,
      'fan-in': fanIn,
    }

    const unblocked = cascadeUnblock(tasks, 'worker-1')

    assert.deepEqual(unblocked, ['fan-in'])
    assert.equal(fanIn.status, 'queued')
    assert.equal(fanIn.upstreamResults?.[0]?.taskId, 'worker-1')
    assert.match(fanIn.upstreamResults?.[0]?.resultPreview || '', /WORKER_OK/)
  })
})
