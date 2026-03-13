import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  resolveScheduleWakeSessionIdForTests,
  shouldWakeScheduleSessionForTests,
} from '@/lib/server/runtime/scheduler'

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
})
