import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

// Disable daemon autostart during tests
process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'

import { GET as listMissionsRoute, POST as createMissionRoute } from './route'
import { GET as getMissionRoute, PUT as updateMissionRoute, DELETE as deleteMissionRoute } from './[id]/route'
import { POST as controlMissionRoute } from './[id]/control/route'
import { GET as listReportsRoute, POST as forceReportRoute } from './[id]/reports/route'
import {
  loadAgentMissions,
  saveAgentMissions,
  loadMissionReports,
  saveMissionReports,
  loadAgentMissionEvents,
  saveAgentMissionEvents,
} from '@/lib/server/storage'

const originalMissions = loadAgentMissions()
const originalReports = loadMissionReports()
const originalEvents = loadAgentMissionEvents()

afterEach(() => {
  saveAgentMissions(originalMissions)
  saveMissionReports(originalReports)
  saveAgentMissionEvents(originalEvents)
})

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST /api/missions creates a mission and GET lists it', async () => {
  const req = jsonRequest('http://local/api/missions', {
    title: 'Route smoke',
    goal: 'Demonstrate the API',
    rootSessionId: 'route_smoke_session_1',
    budget: { maxTurns: 5, maxWallclockSec: 120 },
  })
  const createRes = await createMissionRoute(req)
  assert.equal(createRes.status, 200)
  const created = await createRes.json()
  assert.equal(created.status, 'draft')
  assert.ok(created.id)

  const listRes = await listMissionsRoute()
  const items = await listRes.json()
  const found = items.find((m: { id: string }) => m.id === created.id)
  assert.ok(found, 'created mission should appear in list')
})

test('POST /api/missions rejects a body missing rootSessionId', async () => {
  const req = jsonRequest('http://local/api/missions', {
    title: 'Broken',
    goal: 'No session',
  })
  const res = await createMissionRoute(req)
  assert.equal(res.status, 400)
})

test('GET /api/missions/:id returns 404 for unknown id', async () => {
  const res = await getMissionRoute(
    new Request('http://local/api/missions/does-not-exist'),
    routeParams('does-not-exist'),
  )
  assert.equal(res.status, 404)
})

test('PUT /api/missions/:id patches allowed fields only', async () => {
  const created = await createMissionRoute(
    jsonRequest('http://local/api/missions', {
      title: 'Update target',
      goal: 'before',
      rootSessionId: 'route_update_session',
    }),
  ).then((r) => r.json())

  const res = await updateMissionRoute(
    jsonRequest(`http://local/api/missions/${created.id}`, {
      goal: 'after',
      budget: { maxTurns: 99 },
    }, 'PUT'),
    routeParams(created.id),
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.goal, 'after')
  assert.equal(body.budget.maxTurns, 99)
  assert.equal(body.title, 'Update target', 'unchanged fields preserved')
})

test('POST /api/missions/:id/control transitions draft to running', async () => {
  const created = await createMissionRoute(
    jsonRequest('http://local/api/missions', {
      title: 'Control target',
      goal: 'run',
      rootSessionId: 'route_control_session',
    }),
  ).then((r) => r.json())

  const res = await controlMissionRoute(
    jsonRequest(`http://local/api/missions/${created.id}/control`, { action: 'start' }),
    routeParams(created.id),
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'running')
})

test('POST /api/missions/:id/reports force-generates a report', async () => {
  const created = await createMissionRoute(
    jsonRequest('http://local/api/missions', {
      title: 'Report target',
      goal: 'produce reports',
      rootSessionId: 'route_report_session',
    }),
  ).then((r) => r.json())
  await controlMissionRoute(
    jsonRequest(`http://local/api/missions/${created.id}/control`, { action: 'start' }),
    routeParams(created.id),
  )

  const genRes = await forceReportRoute(
    new Request(`http://local/api/missions/${created.id}/reports`, { method: 'POST' }),
    routeParams(created.id),
  )
  assert.equal(genRes.status, 200)
  const report = await genRes.json()
  assert.equal(report.format, 'markdown')
  assert.ok(report.body.includes('Report target'))

  const listRes = await listReportsRoute(
    new Request(`http://local/api/missions/${created.id}/reports`),
    routeParams(created.id),
  )
  assert.equal(listRes.status, 200)
  const reports = await listRes.json()
  assert.ok(reports.find((r: { id: string }) => r.id === report.id))
})

test('DELETE /api/missions/:id removes the mission', async () => {
  const created = await createMissionRoute(
    jsonRequest('http://local/api/missions', {
      title: 'Delete target',
      goal: 'bye',
      rootSessionId: 'route_delete_session',
    }),
  ).then((r) => r.json())

  const res = await deleteMissionRoute(
    new Request(`http://local/api/missions/${created.id}`, { method: 'DELETE' }),
    routeParams(created.id),
  )
  assert.equal(res.status, 200)

  const getRes = await getMissionRoute(
    new Request(`http://local/api/missions/${created.id}`),
    routeParams(created.id),
  )
  assert.equal(getRes.status, 404)
})
