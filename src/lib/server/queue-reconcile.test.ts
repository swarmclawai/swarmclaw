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
      const storageMod = await import('./src/lib/server/storage')
      const queueMod = await import('./src/lib/server/queue')
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
          threadSessionId: null,
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
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
      }))
    `)

    assert.equal(output.result.reconciled, 1)
    assert.equal(output.task.status, 'completed')
    assert.equal(output.schedule, null)
    assert.equal(output.session.heartbeatEnabled, false)
    assert.match(output.task.result, /WhatsApp follow-up/i)
  })
})
