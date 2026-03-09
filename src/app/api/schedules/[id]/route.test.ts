import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { DELETE as deleteScheduleRoute, PUT as updateSchedule } from './route'
import { loadAgents, loadSchedules, saveAgents, saveSchedules } from '@/lib/server/storage'

const originalAgents = loadAgents()
const originalSchedules = loadSchedules()

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function seedAgent(id: string, overrides: Record<string, unknown> = {}) {
  const agents = loadAgents()
  const now = Date.now()
  agents[id] = {
    id,
    name: 'Schedule Route Agent',
    description: 'Schedule route test agent',
    systemPrompt: 'Handle schedules.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: null,
    plugins: ['manage_schedules'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  saveAgents(agents)
}

afterEach(() => {
  saveAgents(originalAgents)
  saveSchedules(originalSchedules)
})

test('PUT /api/schedules/[id] pauses equivalent reminder schedules together', async () => {
  seedAgent('schedule-route-agent')
  const now = Date.now()
  saveSchedules({
    one: {
      id: 'one',
      name: 'Iran Update',
      agentId: 'schedule-route-agent',
      taskPrompt: 'Daily check for updates on US-Iran tensions',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      status: 'active',
      createdByAgentId: 'schedule-route-agent',
      createdInSessionId: 'session-reminder',
      createdAt: now,
      updatedAt: now,
    },
    two: {
      id: 'two',
      name: 'Iran Reminder',
      agentId: 'schedule-route-agent',
      taskPrompt: 'Periodic update check for US-Iran tensions',
      scheduleType: 'interval',
      intervalMs: 86_400_000,
      status: 'active',
      createdByAgentId: 'schedule-route-agent',
      createdInSessionId: 'session-reminder',
      createdAt: now + 1,
      updatedAt: now + 1,
    },
  })

  const response = await updateSchedule(new Request('http://local/api/schedules/one', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'paused' }),
  }), routeParams('one'))

  assert.equal(response.status, 200)
  const payload = await response.json() as Record<string, unknown>
  assert.deepEqual(new Set(payload.affectedScheduleIds as string[]), new Set(['one', 'two']))

  const schedules = loadSchedules()
  assert.equal(schedules.one.status, 'paused')
  assert.equal(schedules.two.status, 'paused')
})

test('DELETE /api/schedules/[id] deletes equivalent reminder schedules together', async () => {
  seedAgent('schedule-route-agent-delete')
  const now = Date.now()
  saveSchedules({
    one: {
      id: 'one',
      name: 'Iran Update',
      agentId: 'schedule-route-agent-delete',
      taskPrompt: 'Daily check for updates on US-Iran tensions',
      scheduleType: 'cron',
      cron: '0 9 * * *',
      status: 'active',
      createdByAgentId: 'schedule-route-agent-delete',
      createdInSessionId: 'session-reminder',
      createdAt: now,
      updatedAt: now,
    },
    two: {
      id: 'two',
      name: 'Iran Reminder',
      agentId: 'schedule-route-agent-delete',
      taskPrompt: 'Periodic update check for US-Iran tensions',
      scheduleType: 'interval',
      intervalMs: 86_400_000,
      status: 'active',
      createdByAgentId: 'schedule-route-agent-delete',
      createdInSessionId: 'session-reminder',
      createdAt: now + 1,
      updatedAt: now + 1,
    },
  })

  const response = await deleteScheduleRoute(
    new Request('http://local/api/schedules/one', { method: 'DELETE' }),
    routeParams('one'),
  )

  assert.equal(response.status, 200)
  const payload = await response.json() as Record<string, unknown>
  assert.deepEqual(new Set(payload.deletedIds as string[]), new Set(['one', 'two']))
  assert.deepEqual(loadSchedules(), {})
})
