import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  dequeueNextRunnableTask,
  resolveTaskOriginConnectorFollowupTarget,
  resolveTaskResumeContext,
  resolveReusableTaskSessionId,
  applyTaskResumeStateToSession,
} from '@/lib/server/runtime/queue'
import type { BoardTask, Session } from '@/types'

function makeTask(partial?: Partial<BoardTask> & { createdInSessionId?: string | null }): BoardTask {
  const now = Date.now()
  return { id: 'task-1', title: 'Test task', description: 'desc', status: 'queued', agentId: 'agent-a', createdAt: now, updatedAt: now, ...(partial || {}) } as BoardTask
}

// ---------------------------------------------------------------------------
// dequeueNextRunnableTask
// ---------------------------------------------------------------------------

describe('dequeueNextRunnableTask', () => {
  it('diamond dependency graph — dequeues unblocked leaves in FIFO order', () => {
    const taskA = makeTask({ id: 'A', status: 'completed', title: 'A' })
    const taskB = makeTask({ id: 'B', status: 'queued', title: 'B', blockedBy: ['A'] })
    const taskC = makeTask({ id: 'C', status: 'queued', title: 'C', blockedBy: ['A'] })
    const taskD = makeTask({ id: 'D', status: 'queued', title: 'D', blockedBy: ['B', 'C'] })

    const tasks: Record<string, BoardTask> = {
      A: taskA, B: taskB, C: taskC, D: taskD,
    }

    // B and C both unblocked (A completed). D still blocked by B and C.
    const queue1 = ['B', 'C', 'D']
    const first = dequeueNextRunnableTask(queue1, tasks)
    assert.equal(first, 'B', 'first dequeue should pick B (FIFO)')
    assert.deepStrictEqual(queue1, ['C', 'D'], 'B removed from queue')

    // Complete B, now C is unblocked, D still blocked by C.
    tasks.B.status = 'completed'
    const queue2 = ['C', 'D']
    const second = dequeueNextRunnableTask(queue2, tasks)
    assert.equal(second, 'C', 'second dequeue should pick C')
    assert.deepStrictEqual(queue2, ['D'], 'C removed from queue')

    // Complete C, now D is unblocked.
    tasks.C.status = 'completed'
    const queue3 = ['D']
    const third = dequeueNextRunnableTask(queue3, tasks)
    assert.equal(third, 'D', 'third dequeue should pick D (all blockers completed)')
    assert.deepStrictEqual(queue3, [], 'queue is now empty')
  })

  it('retry scheduling gate — skips tasks with future retryScheduledAt', () => {
    const futureMs = Date.now() + 60_000
    const taskFuture = makeTask({ id: 'future', retryScheduledAt: futureMs })
    const tasks: Record<string, BoardTask> = { future: taskFuture }
    const queue = ['future']

    const result = dequeueNextRunnableTask(queue, tasks)
    assert.equal(result, null, 'should not dequeue task scheduled in the future')

    // Now set retryScheduledAt to the past.
    taskFuture.retryScheduledAt = Date.now() - 1000
    const queue2 = ['future']
    const result2 = dequeueNextRunnableTask(queue2, tasks)
    assert.equal(result2, 'future', 'should dequeue task with past retryScheduledAt')
  })

  it('stale queue cleanup — skips missing/non-queued tasks without crashing', () => {
    const taskValid = makeTask({ id: 'valid', title: 'Valid' })
    const taskCompleted = makeTask({ id: 'done', status: 'completed', title: 'Done' })
    const tasks: Record<string, BoardTask> = { valid: taskValid, done: taskCompleted }

    // Queue has stale IDs: 'ghost' doesn't exist, 'done' is completed, then 'valid'.
    const queue = ['ghost', 'done', 'valid']
    const result = dequeueNextRunnableTask(queue, tasks)
    assert.equal(result, 'valid', 'should skip stale entries and dequeue valid task')
  })

  it('empty queue returns null', () => {
    const result = dequeueNextRunnableTask([], {})
    assert.equal(result, null)
  })

  it('all-blocked queue returns null', () => {
    const taskA = makeTask({ id: 'A', status: 'queued', blockedBy: ['X'] })
    const taskB = makeTask({ id: 'B', status: 'queued', blockedBy: ['Y'] })
    const taskX = makeTask({ id: 'X', status: 'running' })
    const taskY = makeTask({ id: 'Y', status: 'running' })
    const tasks: Record<string, BoardTask> = { A: taskA, B: taskB, X: taskX, Y: taskY }

    const queue = ['A', 'B']
    const result = dequeueNextRunnableTask(queue, tasks)
    assert.equal(result, null, 'should return null when all tasks are blocked')
  })

  it('priority ordering — FIFO among unblocked tasks', () => {
    const t1 = makeTask({ id: 't1', title: 'First' })
    const t2 = makeTask({ id: 't2', title: 'Second' })
    const t3 = makeTask({ id: 't3', title: 'Third' })
    const tasks: Record<string, BoardTask> = { t1, t2, t3 }

    const queue = ['t1', 't2', 't3']
    const first = dequeueNextRunnableTask(queue, tasks)
    assert.equal(first, 't1', 'first in queue gets dequeued first')
    const second = dequeueNextRunnableTask(queue, tasks)
    assert.equal(second, 't2')
    const third = dequeueNextRunnableTask(queue, tasks)
    assert.equal(third, 't3')
    const fourth = dequeueNextRunnableTask(queue, tasks)
    assert.equal(fourth, null)
  })
})

// ---------------------------------------------------------------------------
// resolveTaskResumeContext
// ---------------------------------------------------------------------------

describe('resolveTaskResumeContext', () => {
  it('self-resume from codexResumeId on the task itself', () => {
    const task = makeTask({
      id: 'self-task',
      codexResumeId: 'codex-thread-abc',
      sessionId: 'sess-1',
    })
    const tasksById: Record<string, BoardTask> = { 'self-task': task }
    const result = resolveTaskResumeContext(task, tasksById)

    assert.ok(result, 'should find resume context')
    assert.equal(result.source, 'self')
    assert.equal(result.sourceTaskId, 'self-task')
    assert.equal(result.resume.codexThreadId, 'codex-thread-abc')
  })

  it('deep delegation chain resume — falls back to parent task', () => {
    const grandparent = makeTask({
      id: 'gp',
      status: 'completed',
      title: 'Grandparent',
      claudeResumeId: 'claude-gp',
    })
    const parent = makeTask({
      id: 'parent',
      status: 'completed',
      title: 'Parent',
      delegatedFromTaskId: 'gp',
      codexResumeId: 'codex-parent',
    })
    const child = makeTask({
      id: 'child',
      status: 'queued',
      title: 'Child',
      delegatedFromTaskId: 'parent',
    })
    const tasksById: Record<string, BoardTask> = { gp: grandparent, parent, child }

    const result = resolveTaskResumeContext(child, tasksById)
    assert.ok(result, 'should resolve resume context')
    // Child has no resume state itself, so it should fall through to delegatedFromTaskId (parent).
    assert.equal(result.source, 'delegated_from_task')
    assert.equal(result.sourceTaskId, 'parent')
    assert.equal(result.resume.codexThreadId, 'codex-parent')
  })

  it('blocked-by resume with multiple blockers — falls back to second', () => {
    const blockerNoResume = makeTask({
      id: 'blocker-1',
      status: 'completed',
      title: 'Blocker 1',
      // No resume state at all.
    })
    const blockerWithResume = makeTask({
      id: 'blocker-2',
      status: 'completed',
      title: 'Blocker 2',
      claudeResumeId: 'claude-b2',
    })
    const task = makeTask({
      id: 'blocked-task',
      blockedBy: ['blocker-1', 'blocker-2'],
    })
    const tasksById: Record<string, BoardTask> = {
      'blocker-1': blockerNoResume,
      'blocker-2': blockerWithResume,
      'blocked-task': task,
    }

    const result = resolveTaskResumeContext(task, tasksById)
    assert.ok(result, 'should find resume context from second blocker')
    assert.equal(result.source, 'blocked_by')
    assert.equal(result.sourceTaskId, 'blocker-2')
    assert.equal(result.resume.claudeSessionId, 'claude-b2')
  })

  it('no resume context available — returns null', () => {
    const task = makeTask({ id: 'fresh' })
    const tasksById: Record<string, BoardTask> = { fresh: task }

    const result = resolveTaskResumeContext(task, tasksById)
    assert.equal(result, null)
  })
})

// ---------------------------------------------------------------------------
// resolveReusableTaskSessionId
// ---------------------------------------------------------------------------

describe('resolveReusableTaskSessionId', () => {
  it('reuse blocker session when task has no own session', () => {
    const blocker = makeTask({
      id: 'blocker',
      status: 'completed',
      sessionId: 'sess-blocker',
    })
    const task = makeTask({
      id: 'followup',
      blockedBy: ['blocker'],
    })
    const tasks: Record<string, BoardTask> = { blocker, followup: task }
    const sessions: Record<string, Partial<Session>> = {
      'sess-blocker': { id: 'sess-blocker', messages: [] } as Partial<Session>,
    }

    const result = resolveReusableTaskSessionId(task, tasks, sessions as Record<string, Session>)
    assert.equal(result, 'sess-blocker')
  })

  it('prefer task own checkpoint.lastSessionId over blocker session', () => {
    const blocker = makeTask({
      id: 'blocker',
      status: 'completed',
      sessionId: 'sess-blocker',
    })
    const task = makeTask({
      id: 'followup',
      blockedBy: ['blocker'],
      checkpoint: { lastSessionId: 'sess-own', updatedAt: Date.now() },
    })
    const tasks: Record<string, BoardTask> = { blocker, followup: task }
    const sessions: Record<string, Partial<Session>> = {
      'sess-own': { id: 'sess-own', messages: [] } as Partial<Session>,
      'sess-blocker': { id: 'sess-blocker', messages: [] } as Partial<Session>,
    }

    const result = resolveReusableTaskSessionId(task, tasks, sessions as Record<string, Session>)
    assert.equal(result, 'sess-own', 'should prefer own checkpoint session')
  })

  it('no session available — returns empty string', () => {
    const task = makeTask({ id: 'orphan' })
    const tasks: Record<string, BoardTask> = { orphan: task }

    const result = resolveReusableTaskSessionId(task, tasks, {})
    assert.equal(result, '', 'should return empty string when no session is available')
  })
})

// ---------------------------------------------------------------------------
// resolveTaskOriginConnectorFollowupTarget
// ---------------------------------------------------------------------------

describe('resolveTaskOriginConnectorFollowupTarget', () => {
  it('multi-hop delegation followup via delegatedByAgentId chain', () => {
    // agent-C's task was delegated by agent-B, which traces back to agent-A's connector.
    const task = makeTask({
      id: 'task-c',
      agentId: 'agent-c',
      delegatedByAgentId: 'agent-b',
      createdInSessionId: 'sess-origin',
    } as Partial<BoardTask> & { createdInSessionId: string })

    const sessions: Record<string, { messages: Array<{ role: string; text: string; time: number; source?: { connectorId?: string; channelId?: string } }> }> = {
      'sess-origin': {
        messages: [
          {
            role: 'user',
            text: 'Do this task',
            time: Date.now(),
            source: { connectorId: 'conn-a', channelId: 'channel-1' },
          },
        ],
      },
    }

    const connectors: Record<string, { id: string; name: string; platform: string; agentId: string; config: Record<string, string>; isEnabled: boolean; status: string; createdAt: number; updatedAt: number }> = {
      'conn-a': {
        id: 'conn-a',
        name: 'Agent A WhatsApp',
        platform: 'discord',
        agentId: 'agent-a',
        config: {},
        isEnabled: true,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }

    const running = [
      {
        id: 'conn-a',
        platform: 'discord',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      },
    ]

    // The connector belongs to agent-a. The task's agentId is agent-c and
    // delegatedByAgentId is agent-b. Neither matches agent-a, so the connector
    // should NOT match (owner filter excludes it).
    const result = resolveTaskOriginConnectorFollowupTarget({
      task: task as never,
      sessions: sessions as never,
      connectors: connectors as never,
      running,
    })
    assert.equal(result, null, 'connector owned by agent-a should not be accessible via agent-c delegated by agent-b')

    // Now set delegatedByAgentId to agent-a — it should match.
    const mutableTask = task as unknown as Record<string, unknown>
    mutableTask.delegatedByAgentId = 'agent-a'
    const result2 = resolveTaskOriginConnectorFollowupTarget({
      task: task as never,
      sessions: sessions as never,
      connectors: connectors as never,
      running,
    })
    assert.ok(result2, 'should find connector followup target when delegatedByAgentId matches connector owner')
    assert.equal(result2.connectorId, 'conn-a')
    assert.equal(result2.channelId, 'channel-1')
  })

  it('WhatsApp connector normalizes channel to JID format', () => {
    const task = makeTask({
      id: 'wa-task',
      agentId: 'agent-wa',
      createdInSessionId: 'sess-wa',
    } as Partial<BoardTask> & { createdInSessionId: string })

    const sessions: Record<string, { messages: Array<{ role: string; text: string; time: number; source?: { connectorId?: string; channelId?: string } }> }> = {
      'sess-wa': {
        messages: [
          {
            role: 'user',
            text: 'Check status',
            time: Date.now(),
            source: { connectorId: 'conn-wa', channelId: '+1 555 000 0000' },
          },
        ],
      },
    }

    const connectors: Record<string, { id: string; name: string; platform: string; agentId: string; config: Record<string, string>; isEnabled: boolean; status: string; createdAt: number; updatedAt: number }> = {
      'conn-wa': {
        id: 'conn-wa',
        name: 'WhatsApp',
        platform: 'whatsapp',
        agentId: 'agent-wa',
        config: {},
        isEnabled: true,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }

    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-wa',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      },
    ]

    const result = resolveTaskOriginConnectorFollowupTarget({
      task: task as never,
      sessions: sessions as never,
      connectors: connectors as never,
      running,
    })

    assert.ok(result, 'should resolve WhatsApp followup target')
    assert.equal(result.connectorId, 'conn-wa')
    // +1 555 000 0000 → cleaned to 15550000000 → 15550000000@s.whatsapp.net
    assert.equal(result.channelId, '15550000000@s.whatsapp.net')
  })

  it('no user messages with connector source — returns null', () => {
    const task = makeTask({
      id: 'no-source',
      agentId: 'agent-x',
      createdInSessionId: 'sess-empty',
    } as Partial<BoardTask> & { createdInSessionId: string })

    const sessions: Record<string, { messages: Array<{ role: string; text: string; time: number }> }> = {
      'sess-empty': {
        messages: [
          { role: 'user', text: 'Hello', time: Date.now() },
          { role: 'assistant', text: 'Hi there', time: Date.now() },
        ],
      },
    }

    const result = resolveTaskOriginConnectorFollowupTarget({
      task: task as never,
      sessions: sessions as never,
      connectors: {},
      running: [],
    })

    assert.equal(result, null, 'should return null when no messages have connector source')
  })
})

// ---------------------------------------------------------------------------
// applyTaskResumeStateToSession
// ---------------------------------------------------------------------------

describe('applyTaskResumeStateToSession', () => {
  function makeSession(partial?: Partial<Session>): Session {
    return {
      id: 'sess-1',
      name: 'Test',
      cwd: '/tmp',
      user: 'test',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      ...(partial || {}),
    } as Session
  }

  it('partial resume — only codexThreadId set, others null', () => {
    const session = makeSession()
    const resume = {
      claudeSessionId: null,
      codexThreadId: 'codex-123',
      opencodeSessionId: null,
      delegateResumeIds: {
        claudeCode: null,
        codex: 'codex-123',
        opencode: null,
        gemini: null,
      },
    }

    const changed = applyTaskResumeStateToSession(session, resume)
    assert.equal(changed, true, 'should report change')
    assert.equal(session.codexThreadId, 'codex-123')
    assert.equal(session.claudeSessionId, null, 'claudeSessionId should remain null')
  })

  it('no-op when session already has the same resume state', () => {
    const session = makeSession({
      claudeSessionId: 'claude-abc',
      codexThreadId: 'codex-123',
      opencodeSessionId: 'oc-456',
      delegateResumeIds: {
        claudeCode: 'claude-abc',
        codex: 'codex-123',
        opencode: 'oc-456',
        gemini: 'gem-789',
      },
    })

    const resume = {
      claudeSessionId: 'claude-abc',
      codexThreadId: 'codex-123',
      opencodeSessionId: 'oc-456',
      delegateResumeIds: {
        claudeCode: 'claude-abc',
        codex: 'codex-123',
        opencode: 'oc-456',
        gemini: 'gem-789',
      },
    }

    const changed = applyTaskResumeStateToSession(session, resume)
    assert.equal(changed, false, 'should return false when nothing changes')
  })

  it('full resume state hydration — all 4 fields applied', () => {
    const session = makeSession()
    const resume = {
      claudeSessionId: 'claude-new',
      codexThreadId: 'codex-new',
      opencodeSessionId: 'oc-new',
      delegateResumeIds: {
        claudeCode: 'claude-new',
        codex: 'codex-new',
        opencode: 'oc-new',
        gemini: 'gem-new',
      },
    }

    const changed = applyTaskResumeStateToSession(session, resume)
    assert.equal(changed, true, 'should report change')
    assert.equal(session.claudeSessionId, 'claude-new')
    assert.equal(session.codexThreadId, 'codex-new')
    assert.equal(session.opencodeSessionId, 'oc-new')
    assert.deepStrictEqual(session.delegateResumeIds, {
      claudeCode: 'claude-new',
      codex: 'codex-new',
      opencode: 'oc-new',
      gemini: 'gem-new',
    })
  })

  it('returns false for null resume', () => {
    const session = makeSession()
    const changed = applyTaskResumeStateToSession(session, null)
    assert.equal(changed, false)
  })

  it('returns false for undefined resume', () => {
    const session = makeSession()
    const changed = applyTaskResumeStateToSession(session, undefined)
    assert.equal(changed, false)
  })
})
