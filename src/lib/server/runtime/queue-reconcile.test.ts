import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-queue-reconcile-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        SWARMCLAW_BUILD_MODE: '1',
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('reconcileFinishedRunningTasks', () => {
  it('finalizes a completed one-off scheduled task from its finished session and deletes the schedule', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      const workspace = process.env.WORKSPACE_DIR
      storage.saveAgents({
        agent_birthday: {
          id: 'agent_birthday',
          name: 'Birthday Bot',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          threadSessionId: 'thread-birthday',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        'origin-birthday': {
          id: 'origin-birthday',
          name: 'Origin Chat',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now - 10_000,
          lastActiveAt: now - 5_000,
          active: true,
          currentRunId: null,
          agentId: 'agent_birthday',
        },
        'thread-birthday': {
          id: 'thread-birthday',
          name: 'Birthday Bot',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now - 10_000,
          lastActiveAt: now - 5_000,
          active: true,
          currentRunId: null,
          agentId: 'agent_birthday',
          shortcutForAgentId: 'agent_birthday',
        },
        'session-birthday': {
          id: 'session-birthday',
          name: 'Birthday Run',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            {
              role: 'assistant',
              text: 'Happy birthday. I sent a WhatsApp follow-up to the user directly and confirmed delivery with message id 3EB0B7262FF68B7BD261D4.',
              time: now,
            },
          ],
          createdAt: now - 10_000,
          lastActiveAt: now,
          active: false,
          currentRunId: null,
          heartbeatEnabled: true,
        },
      })
      storage.saveSchedules({
        'schedule-birthday': {
          id: 'schedule-birthday',
          name: 'Birthday Reminder',
          scheduleType: 'once',
          status: 'completed',
          agentId: 'agent_birthday',
          createdByAgentId: 'agent_birthday',
          createdInSessionId: 'origin-birthday',
          createdAt: now - 20_000,
          updatedAt: now - 5_000,
        },
      })
      storage.saveTasks({
        'task-birthday': {
          id: 'task-birthday',
          title: 'Birthday follow-up',
          description: 'Wish me happy birthday tomorrow over WhatsApp.',
          status: 'running',
          agentId: 'agent_birthday',
          createdAt: now - 20_000,
          updatedAt: now - 5_000,
          startedAt: now - 15_000,
          sessionId: 'session-birthday',
          sourceType: 'schedule',
          sourceScheduleId: 'schedule-birthday',
          sourceScheduleName: 'Birthday Reminder',
          createdInSessionId: 'origin-birthday',
          maxAttempts: 3,
          retryBackoffSec: 30,
        },
      })

      const result = queue.reconcileFinishedRunningTasks()
      console.log(JSON.stringify({
        result,
        task: storage.loadTasks()['task-birthday'],
        schedule: storage.loadSchedules()['schedule-birthday'] || null,
        session: storage.loadSessions()['session-birthday'],
        originMessages: storage.loadSessions()['origin-birthday'].messages,
        threadMessages: storage.loadSessions()['thread-birthday'].messages,
      }))
    `)

    assert.equal(output.result.reconciled, 1)
    assert.equal(output.task.status, 'completed')
    assert.equal(output.schedule?.status, 'completed')
    assert.equal(output.session.heartbeatEnabled, false)
    assert.match(output.task.result, /WhatsApp follow-up/i)
    assert.deepEqual(output.originMessages, [])
    assert.deepEqual(output.threadMessages, [])
  })

  it('posts exactly one terminal update to the originating session for user-created tasks', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      const workspace = process.env.WORKSPACE_DIR
      storage.saveAgents({
        agent_writer: {
          id: 'agent_writer',
          name: 'Writer Bot',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          threadSessionId: 'thread-writer',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        'origin-task': {
          id: 'origin-task',
          name: 'Project Chat',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now - 10_000,
          lastActiveAt: now - 5_000,
          active: true,
          currentRunId: null,
          agentId: 'agent_writer',
        },
        'thread-writer': {
          id: 'thread-writer',
          name: 'Writer Bot',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now - 10_000,
          lastActiveAt: now - 5_000,
          active: true,
          currentRunId: null,
          agentId: 'agent_writer',
          shortcutForAgentId: 'agent_writer',
        },
        'run-task': {
          id: 'run-task',
          name: 'Execution Session',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            {
              role: 'assistant',
              text: 'Updated docs/summary.md, verified with npm test passed, and confirmed the summary reflects the final meeting decisions.',
              time: now,
            },
          ],
          createdAt: now - 10_000,
          lastActiveAt: now,
          active: false,
          currentRunId: null,
          heartbeatEnabled: true,
        },
      })
      storage.saveTasks({
        'task-manual': {
          id: 'task-manual',
          title: 'Write summary',
          description: 'Summarize the meeting notes.',
          status: 'running',
          agentId: 'agent_writer',
          createdAt: now - 20_000,
          updatedAt: now - 5_000,
          startedAt: now - 15_000,
          sessionId: 'run-task',
          createdInSessionId: 'origin-task',
          sourceType: 'manual',
          maxAttempts: 3,
          retryBackoffSec: 30,
        },
      })

      const result = queue.reconcileFinishedRunningTasks()
      const sessions = storage.loadSessions()
      console.log(JSON.stringify({
        result,
        task: storage.loadTasks()['task-manual'],
        originMessages: sessions['origin-task'].messages,
        threadMessages: sessions['thread-writer'].messages,
      }))
    `)

    assert.equal(output.result.reconciled, 1)
    assert.equal(output.task.status, 'completed')
    assert.equal(output.originMessages.length, 1)
    assert.match(output.originMessages[0].text, /^Task completed: \*\*\[Write summary\]\(#task:task-manual\)\*\*/)
    assert.match(output.originMessages[0].text, /docs\/summary\.md/)
    assert.deepEqual(output.threadMessages, [])
  })

  it('keeps agent-created task completions out of user-facing chat sessions', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      const workspace = process.env.WORKSPACE_DIR
      storage.saveAgents({
        agent_ops: {
          id: 'agent_ops',
          name: 'Ops Bot',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          threadSessionId: 'thread-ops',
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        'origin-ops': {
          id: 'origin-ops',
          name: 'Origin Chat',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now - 10_000,
          lastActiveAt: now - 5_000,
          active: true,
          currentRunId: null,
          agentId: 'agent_ops',
        },
        'thread-ops': {
          id: 'thread-ops',
          name: 'Ops Bot',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now - 10_000,
          lastActiveAt: now - 5_000,
          active: true,
          currentRunId: null,
          agentId: 'agent_ops',
          shortcutForAgentId: 'agent_ops',
        },
        'run-ops': {
          id: 'run-ops',
          name: 'Execution Session',
          cwd: workspace,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [
            {
              role: 'assistant',
              text: 'Health check completed successfully.',
              time: now,
            },
          ],
          createdAt: now - 10_000,
          lastActiveAt: now,
          active: false,
          currentRunId: null,
          heartbeatEnabled: true,
        },
      })
      storage.saveTasks({
        'task-agent': {
          id: 'task-agent',
          title: 'Self check',
          description: 'Run an internal health check.',
          status: 'running',
          agentId: 'agent_ops',
          createdAt: now - 20_000,
          updatedAt: now - 5_000,
          startedAt: now - 15_000,
          sessionId: 'run-ops',
          createdInSessionId: 'origin-ops',
          createdByAgentId: 'agent_ops',
          sourceType: 'manual',
          maxAttempts: 3,
          retryBackoffSec: 30,
        },
      })

      const result = queue.reconcileFinishedRunningTasks()
      const sessions = storage.loadSessions()
      console.log(JSON.stringify({
        result,
        task: storage.loadTasks()['task-agent'],
        originMessages: sessions['origin-ops'].messages,
        threadMessages: sessions['thread-ops'].messages,
      }))
    `)

    assert.equal(output.result.reconciled, 1)
    assert.equal(output.task.status, 'completed')
    assert.deepEqual(output.originMessages, [])
    assert.deepEqual(output.threadMessages, [])
  })
})
