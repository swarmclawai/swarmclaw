import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { BoardTask, Session } from '@/types'
import type { SessionLike } from '@/lib/server/tasks/task-followups'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let queue: typeof import('@/lib/server/runtime/queue')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-queue-test-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })
  queue = await import('@/lib/server/runtime/queue')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeTask(overrides: Partial<import('@/types').BoardTask> = {}): import('@/types').BoardTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test task',
    description: 'A test task',
    status: 'queued',
    agentId: 'agent-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// dequeueNextRunnableTask
// ---------------------------------------------------------------------------
describe('dequeueNextRunnableTask', () => {
  it('returns the first queued task from the queue', () => {
    const t1 = makeTask({ id: 'a', status: 'queued' })
    const t2 = makeTask({ id: 'b', status: 'queued' })
    const tasks = { a: t1, b: t2 }
    const q = ['a', 'b']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'a')
    assert.deepEqual(q, ['b'])
  })

  it('returns null for empty queue', () => {
    const result = queue.dequeueNextRunnableTask([], {})
    assert.equal(result, null)
  })

  it('strips stale non-queued entries before dequeuing', () => {
    const t1 = makeTask({ id: 'a', status: 'completed' })
    const t2 = makeTask({ id: 'b', status: 'queued' })
    const tasks = { a: t1, b: t2 }
    const q = ['a', 'b']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'b')
    assert.deepEqual(q, [])
  })

  it('strips entries for missing tasks', () => {
    const t2 = makeTask({ id: 'b', status: 'queued' })
    const tasks = { b: t2 }
    const q = ['nonexistent', 'b']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'b')
    assert.deepEqual(q, [])
  })

  it('skips tasks blocked by incomplete dependencies', () => {
    const blocker = makeTask({ id: 'dep', status: 'running' })
    const blocked = makeTask({ id: 'child', status: 'queued', blockedBy: ['dep'] })
    const unblocked = makeTask({ id: 'free', status: 'queued' })
    const tasks = { dep: blocker, child: blocked, free: unblocked }
    const q = ['child', 'free']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'free')
    assert.deepEqual(q, ['child'])
  })

  it('dequeues blocked task when all blockers are completed', () => {
    const blocker = makeTask({ id: 'dep', status: 'completed' })
    const blocked = makeTask({ id: 'child', status: 'queued', blockedBy: ['dep'] })
    const tasks = { dep: blocker, child: blocked }
    const q = ['child']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'child')
    assert.deepEqual(q, [])
  })

  it('skips tasks with future retryScheduledAt', () => {
    const t = makeTask({ id: 'retry', status: 'queued', retryScheduledAt: Date.now() + 60_000 })
    const tasks = { retry: t }
    const q = ['retry']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, null)
    assert.deepEqual(q, ['retry'])
  })

  it('dequeues tasks with past retryScheduledAt', () => {
    const t = makeTask({ id: 'retry', status: 'queued', retryScheduledAt: Date.now() - 1000 })
    const tasks = { retry: t }
    const q = ['retry']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'retry')
    assert.deepEqual(q, [])
  })

  it('respects FIFO ordering for tasks at same priority', () => {
    const t1 = makeTask({ id: 'first', status: 'queued' })
    const t2 = makeTask({ id: 'second', status: 'queued' })
    const t3 = makeTask({ id: 'third', status: 'queued' })
    const tasks = { first: t1, second: t2, third: t3 }
    const q = ['first', 'second', 'third']
    assert.equal(queue.dequeueNextRunnableTask(q, tasks), 'first')
    assert.equal(queue.dequeueNextRunnableTask(q, tasks), 'second')
    assert.equal(queue.dequeueNextRunnableTask(q, tasks), 'third')
    assert.equal(queue.dequeueNextRunnableTask(q, tasks), null)
  })

  it('skips multiple blocked tasks and finds a runnable one deeper in the queue', () => {
    const dep1 = makeTask({ id: 'dep1', status: 'running' })
    const dep2 = makeTask({ id: 'dep2', status: 'running' })
    const b1 = makeTask({ id: 'b1', status: 'queued', blockedBy: ['dep1'] })
    const b2 = makeTask({ id: 'b2', status: 'queued', blockedBy: ['dep2'] })
    const free = makeTask({ id: 'free', status: 'queued' })
    const tasks = { dep1, dep2, b1, b2, free }
    const q = ['b1', 'b2', 'free']
    const result = queue.dequeueNextRunnableTask(q, tasks)
    assert.equal(result, 'free')
    assert.deepEqual(q, ['b1', 'b2'])
  })
})

// ---------------------------------------------------------------------------
// extractTaskResumeState
// ---------------------------------------------------------------------------
describe('extractTaskResumeState', () => {
  it('returns null for null/undefined input', () => {
    assert.equal(queue.extractTaskResumeState(null), null)
    assert.equal(queue.extractTaskResumeState(undefined), null)
  })

  it('returns null when no resume IDs are present', () => {
    const result = queue.extractTaskResumeState({ id: 'x', title: 'test' })
    assert.equal(result, null)
  })

  it('extracts claudeResumeId', () => {
    const result = queue.extractTaskResumeState({ claudeResumeId: 'claude-123' })
    assert.ok(result)
    assert.equal(result!.claudeSessionId, 'claude-123')
    assert.equal(result!.delegateResumeIds.claudeCode, 'claude-123')
  })

  it('extracts codexResumeId', () => {
    const result = queue.extractTaskResumeState({ codexResumeId: 'codex-abc' })
    assert.ok(result)
    assert.equal(result!.codexThreadId, 'codex-abc')
    assert.equal(result!.delegateResumeIds.codex, 'codex-abc')
  })

  it('extracts opencodeResumeId', () => {
    const result = queue.extractTaskResumeState({ opencodeResumeId: 'oc-456' })
    assert.ok(result)
    assert.equal(result!.opencodeSessionId, 'oc-456')
    assert.equal(result!.delegateResumeIds.opencode, 'oc-456')
  })

  it('falls back to legacy cliResumeId with claude-cli provider', () => {
    const result = queue.extractTaskResumeState({
      cliResumeId: 'legacy-id',
      cliProvider: 'claude-cli',
    })
    assert.ok(result)
    assert.equal(result!.claudeSessionId, 'legacy-id')
    assert.equal(result!.delegateResumeIds.claudeCode, 'legacy-id')
  })

  it('falls back to legacy cliResumeId with codex-cli provider', () => {
    const result = queue.extractTaskResumeState({
      cliResumeId: 'legacy-codex',
      cliProvider: 'codex-cli',
    })
    assert.ok(result)
    assert.equal(result!.codexThreadId, 'legacy-codex')
    assert.equal(result!.delegateResumeIds.codex, 'legacy-codex')
  })

  it('ignores whitespace-only resume IDs', () => {
    const result = queue.extractTaskResumeState({ claudeResumeId: '   ' })
    assert.equal(result, null)
  })

  it('trims resume IDs', () => {
    const result = queue.extractTaskResumeState({ claudeResumeId: ' abc ' })
    assert.ok(result)
    assert.equal(result!.claudeSessionId, 'abc')
  })
})

// ---------------------------------------------------------------------------
// extractSessionResumeState
// ---------------------------------------------------------------------------
describe('extractSessionResumeState', () => {
  it('returns null for null/undefined', () => {
    assert.equal(queue.extractSessionResumeState(null), null)
    assert.equal(queue.extractSessionResumeState(undefined), null)
  })

  it('extracts session-level resume IDs', () => {
    const result = queue.extractSessionResumeState({
      claudeSessionId: 'cs-1',
      codexThreadId: 'ct-2',
    })
    assert.ok(result)
    assert.equal(result!.claudeSessionId, 'cs-1')
    assert.equal(result!.codexThreadId, 'ct-2')
    assert.equal(result!.delegateResumeIds.claudeCode, 'cs-1')
    assert.equal(result!.delegateResumeIds.codex, 'ct-2')
  })

  it('returns null when session has no resume IDs', () => {
    const result = queue.extractSessionResumeState({ id: 'sess-empty' })
    assert.equal(result, null)
  })

  it('prefers delegateResumeIds over direct fields', () => {
    const result = queue.extractSessionResumeState({
      claudeSessionId: 'direct',
      delegateResumeIds: { claudeCode: 'delegate-override', codex: null, opencode: null, gemini: null },
    })
    assert.ok(result)
    assert.equal(result!.delegateResumeIds.claudeCode, 'delegate-override')
  })
})

// ---------------------------------------------------------------------------
// resolveTaskResumeContext
// ---------------------------------------------------------------------------
describe('resolveTaskResumeContext', () => {
  it('returns null when no resume state is available', () => {
    const task = makeTask({ id: 't1' })
    const result = queue.resolveTaskResumeContext(task, { t1: task })
    assert.equal(result, null)
  })

  it('finds resume state from self', () => {
    const task = makeTask({ id: 't1', claudeResumeId: 'cr-self' })
    const result = queue.resolveTaskResumeContext(task, { t1: task })
    assert.ok(result)
    assert.equal(result!.source, 'self')
    assert.equal(result!.sourceTaskId, 't1')
    assert.equal(result!.resume.claudeSessionId, 'cr-self')
  })

  it('finds resume state from delegatedFromTaskId', () => {
    const parent = makeTask({ id: 'parent', claudeResumeId: 'cr-parent' })
    const child = makeTask({ id: 'child', delegatedFromTaskId: 'parent' })
    const result = queue.resolveTaskResumeContext(child, { parent, child })
    assert.ok(result)
    assert.equal(result!.source, 'delegated_from_task')
    assert.equal(result!.sourceTaskId, 'parent')
  })

  it('finds resume state from blockedBy tasks', () => {
    const blocker = makeTask({ id: 'blocker', codexResumeId: 'codex-b' })
    const blocked = makeTask({ id: 'blocked', blockedBy: ['blocker'] })
    const result = queue.resolveTaskResumeContext(blocked, { blocker, blocked })
    assert.ok(result)
    assert.equal(result!.source, 'blocked_by')
    assert.equal(result!.sourceTaskId, 'blocker')
    assert.equal(result!.resume.codexThreadId, 'codex-b')
  })

  it('prefers self over delegated_from_task', () => {
    const parent = makeTask({ id: 'parent', claudeResumeId: 'cr-parent' })
    const child = makeTask({ id: 'child', claudeResumeId: 'cr-self', delegatedFromTaskId: 'parent' })
    const result = queue.resolveTaskResumeContext(child, { parent, child })
    assert.ok(result)
    assert.equal(result!.source, 'self')
    assert.equal(result!.resume.claudeSessionId, 'cr-self')
  })
})

// ---------------------------------------------------------------------------
// applyTaskResumeStateToSession
// ---------------------------------------------------------------------------
describe('applyTaskResumeStateToSession', () => {
  function makeSession(overrides: Record<string, unknown> = {}): Session {
    return {
      id: 'sess-1',
      agentId: 'agent-1',
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      active: true,
      ...overrides,
    } as unknown as Session
  }

  it('returns false for null/undefined resume state', () => {
    const session = makeSession()
    assert.equal(queue.applyTaskResumeStateToSession(session, null), false)
    assert.equal(queue.applyTaskResumeStateToSession(session, undefined), false)
  })

  it('applies claudeSessionId to session', () => {
    const session = makeSession()
    const resume = {
      claudeSessionId: 'cs-1',
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: { claudeCode: 'cs-1', codex: null, opencode: null, gemini: null },
    }
    const changed = queue.applyTaskResumeStateToSession(session, resume)
    assert.equal(changed, true)
    assert.equal(session.claudeSessionId, 'cs-1')
  })

  it('returns false when session already has the same values', () => {
    const session = makeSession({
      claudeSessionId: 'cs-1',
      delegateResumeIds: { claudeCode: 'cs-1', codex: null, opencode: null, gemini: null },
    })
    const resume = {
      claudeSessionId: 'cs-1',
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: { claudeCode: 'cs-1', codex: null, opencode: null, gemini: null },
    }
    const changed = queue.applyTaskResumeStateToSession(session, resume)
    assert.equal(changed, false)
  })

  it('returns false for empty resume state (no IDs set)', () => {
    const session = makeSession()
    const resume = {
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
    }
    const changed = queue.applyTaskResumeStateToSession(session, resume)
    assert.equal(changed, false)
  })
})

// ---------------------------------------------------------------------------
// resolveReusableTaskSessionId
// ---------------------------------------------------------------------------
describe('resolveReusableTaskSessionId', () => {
  it('returns empty string when no session candidates exist', () => {
    const task = makeTask({ id: 't1' })
    const result = queue.resolveReusableTaskSessionId(task, { t1: task }, {})
    assert.equal(result, '')
  })

  it('returns session from task checkpoint', () => {
    const task = makeTask({
      id: 't1',
      checkpoint: { lastSessionId: 'sess-abc', updatedAt: Date.now() },
    })
    const sessions = { 'sess-abc': { id: 'sess-abc', cwd: '/tmp', messages: [], user: '' } }
    const result = queue.resolveReusableTaskSessionId(task, { t1: task }, sessions as Record<string, SessionLike>)
    assert.equal(result, 'sess-abc')
  })

  it('returns session from task sessionId', () => {
    const task = makeTask({ id: 't1', sessionId: 'sess-direct' })
    const sessions = { 'sess-direct': { id: 'sess-direct', cwd: '/tmp', messages: [], user: '' } }
    const result = queue.resolveReusableTaskSessionId(task, { t1: task }, sessions as Record<string, SessionLike>)
    assert.equal(result, 'sess-direct')
  })

  it('prefers checkpoint over sessionId', () => {
    const task = makeTask({
      id: 't1',
      sessionId: 'sess-old',
      checkpoint: { lastSessionId: 'sess-new', updatedAt: Date.now() },
    })
    const sessions = {
      'sess-old': { id: 'sess-old', cwd: '/tmp', messages: [], user: '' },
      'sess-new': { id: 'sess-new', cwd: '/tmp', messages: [], user: '' },
    }
    const result = queue.resolveReusableTaskSessionId(task, { t1: task }, sessions as Record<string, SessionLike>)
    assert.equal(result, 'sess-new')
  })

  it('checks delegatedFromTaskId for sessions', () => {
    const parent = makeTask({ id: 'parent', sessionId: 'sess-parent' })
    const child = makeTask({ id: 'child', delegatedFromTaskId: 'parent' })
    const sessions = { 'sess-parent': { id: 'sess-parent', cwd: '/tmp', messages: [], user: '' } }
    const result = queue.resolveReusableTaskSessionId(child, { parent, child }, sessions as Record<string, SessionLike>)
    assert.equal(result, 'sess-parent')
  })

  it('checks blockedBy tasks for sessions', () => {
    const blocker = makeTask({ id: 'blocker', sessionId: 'sess-blocker' })
    const blocked = makeTask({ id: 'blocked', blockedBy: ['blocker'] })
    const sessions = { 'sess-blocker': { id: 'sess-blocker', cwd: '/tmp', messages: [], user: '' } }
    const result = queue.resolveReusableTaskSessionId(blocked, { blocker, blocked }, sessions as Record<string, SessionLike>)
    assert.equal(result, 'sess-blocker')
  })

  it('returns empty when referenced session does not exist', () => {
    const task = makeTask({ id: 't1', sessionId: 'gone' })
    const result = queue.resolveReusableTaskSessionId(task, { t1: task }, {})
    assert.equal(result, '')
  })
})

// ---------------------------------------------------------------------------
// enqueueTask (integration with storage)
// ---------------------------------------------------------------------------
describe('enqueueTask', () => {
  it('sets task to queued status and adds to queue', async () => {
    const storage = await import('@/lib/server/storage')
    const taskId = 'enq-test-1'
    const tasks: Record<string, BoardTask> = {}
    tasks[taskId] = makeTask({ id: taskId, status: 'backlog' })
    storage.saveTasks(tasks)
    storage.saveQueue([])

    queue.enqueueTask(taskId)

    const updatedTasks = storage.loadTasks()
    const updatedQueue = storage.loadQueue()
    assert.equal(updatedTasks[taskId].status, 'queued')
    assert.ok(updatedTasks[taskId].queuedAt)
    assert.ok(updatedQueue.includes(taskId))
  })

  it('does not duplicate task in queue on double enqueue', async () => {
    const storage = await import('@/lib/server/storage')
    const taskId = 'enq-test-2'
    const tasks: Record<string, BoardTask> = {}
    tasks[taskId] = makeTask({ id: taskId, status: 'backlog' })
    storage.saveTasks(tasks)
    storage.saveQueue([])

    queue.enqueueTask(taskId)
    queue.enqueueTask(taskId)

    const updatedQueue = storage.loadQueue()
    const count = updatedQueue.filter((id: string) => id === taskId).length
    assert.equal(count, 1)
  })

  it('no-ops for nonexistent task', async () => {
    const storage = await import('@/lib/server/storage')
    storage.saveQueue([])
    queue.enqueueTask('does-not-exist')
    const updatedQueue = storage.loadQueue()
    assert.equal(updatedQueue.length, 0)
  })
})

// ---------------------------------------------------------------------------
// cleanupFinishedTaskSessions (integration)
// ---------------------------------------------------------------------------
describe('cleanupFinishedTaskSessions', () => {
  it('disables heartbeat on sessions for completed tasks', async () => {
    const storage = await import('@/lib/server/storage')
    const sessionId = 'sess-cleanup-1'
    const tasks: Record<string, BoardTask> = {}
    tasks['t-done'] = makeTask({ id: 't-done', status: 'completed', sessionId })
    storage.saveTasks(tasks)

    const sessions: Record<string, unknown> = {}
    sessions[sessionId] = {
      id: sessionId,
      agentId: 'a1',
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      active: false,
      heartbeatEnabled: true,
    }
    storage.saveSessions(sessions)

    queue.cleanupFinishedTaskSessions()

    const updated = storage.loadSessions()
    assert.equal(updated[sessionId].heartbeatEnabled, false)
  })

  it('skips sessions already disabled', async () => {
    const storage = await import('@/lib/server/storage')
    const sessionId = 'sess-cleanup-2'
    const tasks: Record<string, BoardTask> = {}
    tasks['t-done2'] = makeTask({ id: 't-done2', status: 'completed', sessionId })
    storage.saveTasks(tasks)

    const sessions: Record<string, unknown> = {}
    sessions[sessionId] = {
      id: sessionId,
      agentId: 'a1',
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now() - 10_000,
      active: false,
      heartbeatEnabled: false,
    }
    storage.saveSessions(sessions)

    queue.cleanupFinishedTaskSessions()

    const updated = storage.loadSessions()
    // lastActiveAt should not have been updated since heartbeat was already disabled
    assert.ok(updated[sessionId].lastActiveAt <= Date.now() - 5_000)
  })
})

// ---------------------------------------------------------------------------
// disableSessionHeartbeat (integration)
// ---------------------------------------------------------------------------
describe('disableSessionHeartbeat', () => {
  it('disables heartbeat on existing session', async () => {
    const storage = await import('@/lib/server/storage')
    const sessionId = 'sess-hb-1'
    const sessions: Record<string, unknown> = {}
    sessions[sessionId] = {
      id: sessionId,
      agentId: 'a1',
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now() - 60_000,
      active: true,
      heartbeatEnabled: true,
    }
    storage.saveSessions(sessions)

    queue.disableSessionHeartbeat(sessionId)

    const updated = storage.loadSessions()
    assert.equal(updated[sessionId].heartbeatEnabled, false)
    assert.ok(updated[sessionId].lastActiveAt > Date.now() - 5_000)
  })

  it('no-ops for null/undefined session ID', async () => {
    queue.disableSessionHeartbeat(null)
    queue.disableSessionHeartbeat(undefined)
    // Should not throw
  })

  it('no-ops for nonexistent session', async () => {
    queue.disableSessionHeartbeat('does-not-exist-session')
    // Should not throw
  })
})
