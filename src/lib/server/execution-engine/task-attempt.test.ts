import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BoardTask } from '@/types'
import { buildTaskAttemptPrompt } from '@/lib/server/execution-engine/task-attempt'

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

describe('buildTaskAttemptPrompt', () => {
  it('includes hydrated upstream results in the actual worker prompt', () => {
    const task = makeTask({
      description: 'Review the worker outputs.',
      upstreamResults: [{
        taskId: 'worker-1',
        taskTitle: 'Worker output',
        agentId: 'agent-1',
        resultPreview: 'WORKER_OK\nUseful findings.',
      }],
    })

    const prompt = buildTaskAttemptPrompt(task)

    assert.match(prompt, /Review the worker outputs\./)
    assert.match(prompt, /## Context from upstream tasks/)
    assert.match(prompt, /### Worker output/)
    assert.match(prompt, /WORKER_OK/)
    assert.match(prompt, /Completion requirements:/)
  })

  it('does not add an upstream context section when no upstream results are present', () => {
    const task = makeTask({ description: 'Standalone task.' })

    const prompt = buildTaskAttemptPrompt(task)

    assert.match(prompt, /Standalone task\./)
    assert.doesNotMatch(prompt, /Context from upstream tasks/)
  })
})
