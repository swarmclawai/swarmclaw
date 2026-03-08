import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { POST as createSchedule } from './route'
import { POST as runSchedule } from './[id]/run/route'
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
    name: 'Schedule Test Agent',
    description: 'Schedule smoke test agent',
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

test('POST /api/schedules rejects disabled agents', async () => {
  seedAgent('schedule-disabled-agent', { disabled: true })

  const response = await createSchedule(new Request('http://local/api/schedules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'schedule-disabled-agent',
      name: 'Disabled smoke',
      taskPrompt: 'Send a reminder',
      scheduleType: 'once',
      runAt: Date.now() + 60_000,
      status: 'active',
    }),
  }))

  assert.equal(response.status, 409)
  const payload = await response.json() as Record<string, unknown>
  assert.match(String(payload.error || ''), /disabled/i)
})

test('POST /api/schedules/[id]/run rejects disabled agents', async () => {
  seedAgent('schedule-run-disabled-agent', { disabled: true })
  const schedules = loadSchedules()
  schedules['schedule-disabled-run'] = {
    id: 'schedule-disabled-run',
    name: 'Disabled Run',
    agentId: 'schedule-run-disabled-agent',
    taskPrompt: 'Send a reminder',
    scheduleType: 'once',
    runAt: Date.now() + 60_000,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveSchedules(schedules)

  const response = await runSchedule(
    new Request('http://local/api/schedules/schedule-disabled-run/run', { method: 'POST' }),
    routeParams('schedule-disabled-run'),
  )

  assert.equal(response.status, 409)
  const payload = await response.json() as Record<string, unknown>
  assert.match(String(payload.error || ''), /disabled/i)
})
