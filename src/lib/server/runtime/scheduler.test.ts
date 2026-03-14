import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  resolveScheduleWakeSessionIdForTests,
  shouldWakeScheduleSessionForTests,
} from '@/lib/server/runtime/scheduler'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runSchedulerWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-scheduler-test-'))
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

describe('scheduler wake targeting', () => {
  it('prefers the originating session for schedule wakes', () => {
    const sessionId = resolveScheduleWakeSessionIdForTests({
      id: 'sched-1',
      name: 'Morning reminder',
      agentId: 'agent-1',
      taskPrompt: 'Remind me',
      scheduleType: 'once',
      status: 'active',
      createdInSessionId: 'session-owner',
    }, {
      'agent-1': {
        id: 'agent-1',
        threadSessionId: 'thread-main',
      },
    })

    assert.equal(sessionId, 'session-owner')
  })

  it('falls back to the agent thread session when the originating session is missing', () => {
    const sessionId = resolveScheduleWakeSessionIdForTests({
      id: 'sched-2',
      name: 'Morning reminder',
      agentId: 'agent-1',
      taskPrompt: 'Remind me',
      scheduleType: 'once',
      status: 'active',
    }, {
      'agent-1': {
        id: 'agent-1',
        threadSessionId: 'thread-main',
      },
    })

    assert.equal(sessionId, 'thread-main')
  })

  it('only wakes sessions for wake-only schedules', () => {
    assert.equal(
      shouldWakeScheduleSessionForTests({
        id: 'sched-task',
        name: 'Queued follow-up',
        agentId: 'agent-1',
        taskPrompt: 'Do the work',
        scheduleType: 'once',
        status: 'active',
        taskMode: 'task',
      }),
      false,
    )

    assert.equal(
      shouldWakeScheduleSessionForTests({
        id: 'sched-wake',
        name: 'Wake me up',
        agentId: 'agent-1',
        taskPrompt: 'Nudge the agent',
        scheduleType: 'once',
        status: 'active',
        taskMode: 'wake_only',
      }),
      true,
    )
  })

  it('keeps wake-only schedule runs out of the creator chat transcript', () => {
    const output = runSchedulerWithTempDataDir(`
      const storageMod = await import('@/lib/server/storage')
      const schedulerMod = await import('@/lib/server/runtime/scheduler')
      const systemEventsMod = await import('@/lib/server/runtime/system-events')
      const heartbeatWakeMod = await import('@/lib/server/runtime/heartbeat-wake')
      const storage = storageMod.default || storageMod
      const scheduler = schedulerMod.default || schedulerMod
      const systemEvents = systemEventsMod.default || systemEventsMod
      const heartbeatWake = heartbeatWakeMod.default || heartbeatWakeMod

      const now = Date.now()
      const workspace = process.env.WORKSPACE_DIR

      storage.saveAgents({
        'agent-1': {
          id: 'agent-1',
          name: 'Reminder Bot',
          description: '',
          systemPrompt: '',
          provider: 'openai',
          model: 'gpt-test',
          threadSessionId: 'thread-main',
          createdAt: now,
          updatedAt: now,
        },
      })

      storage.saveSessions({
        'session-owner': {
          id: 'session-owner',
          name: 'Owner Chat',
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
          agentId: 'agent-1',
        },
        'thread-main': {
          id: 'thread-main',
          name: 'Reminder Bot',
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
          agentId: 'agent-1',
          shortcutForAgentId: 'agent-1',
        },
      })

      storage.saveSchedules({
        'sched-wake': {
          id: 'sched-wake',
          name: 'Wake silently',
          agentId: 'agent-1',
          taskPrompt: 'Check the inbox',
          scheduleType: 'once',
          taskMode: 'wake_only',
          status: 'active',
          runAt: now - 1_000,
          nextRunAt: now - 1_000,
          createdInSessionId: 'session-owner',
          createdAt: now - 10_000,
          updatedAt: now - 10_000,
        },
      })

      await scheduler.runSchedulerTickForTests(now)
      const wakes = heartbeatWake.snapshotPendingHeartbeatWakesForTests()

      console.log(JSON.stringify({
        ownerMessages: storage.loadSessions()['session-owner'].messages,
        systemEvents: systemEvents.peekSystemEvents('session-owner'),
        deliveryModes: wakes.map((wake) => heartbeatWake.deriveHeartbeatWakeDeliveryMode(wake.events)),
      }))
    `)

    assert.deepEqual(output.ownerMessages, [])
    assert.deepEqual(output.systemEvents, [])
    assert.deepEqual(output.deliveryModes, ['silent'])
  })
})
