import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isAgentCreatedSchedule,
  isUserCreatedSchedule,
  shouldAutoDeleteScheduleAfterTerminalRun,
} from './schedule-origin'

test('recognizes agent-created schedules', () => {
  assert.equal(isAgentCreatedSchedule({ scheduleType: 'interval', createdByAgentId: 'molly-2' }), true)
  assert.equal(isUserCreatedSchedule({ scheduleType: 'interval', createdByAgentId: 'molly-2' }), false)
})

test('recognizes manual schedules and only auto-deletes agent-created one-offs', () => {
  assert.equal(isUserCreatedSchedule({ scheduleType: 'once', createdByAgentId: null }), true)
  assert.equal(shouldAutoDeleteScheduleAfterTerminalRun({ scheduleType: 'once', createdByAgentId: null }), false)
  assert.equal(shouldAutoDeleteScheduleAfterTerminalRun({ scheduleType: 'once', createdByAgentId: 'molly-2' }), true)
  assert.equal(shouldAutoDeleteScheduleAfterTerminalRun({ scheduleType: 'interval', createdByAgentId: 'molly-2' }), false)
})
