import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('gateway topology route returns 404 for unknown profiles', () => {
  const output = runWithTempDataDir<{ status: number; body: { error: string } }>(`
    const routeMod = await import('./src/app/api/gateways/[id]/topology/route')
    const route = routeMod.default || routeMod
    const response = await route.GET(
      new Request('http://local/api/gateways/missing/topology'),
      { params: Promise.resolve({ id: 'missing' }) },
    )
    console.log(JSON.stringify({ status: response.status, body: await response.json() }))
  `, { prefix: 'swarmclaw-gateway-topology-route-test-' })

  assert.equal(output.status, 404)
  assert.equal(output.body.error, 'Not found')
})

test('gateway environments route returns 404 for unknown profiles', () => {
  const output = runWithTempDataDir<{ status: number; body: { error: string } }>(`
    const routeMod = await import('./src/app/api/gateways/[id]/environments/route')
    const route = routeMod.default || routeMod
    const response = await route.GET(
      new Request('http://local/api/gateways/missing/environments'),
      { params: Promise.resolve({ id: 'missing' }) },
    )
    console.log(JSON.stringify({ status: response.status, body: await response.json() }))
  `, { prefix: 'swarmclaw-gateway-environments-route-test-' })

  assert.equal(output.status, 404)
  assert.equal(output.body.error, 'Not found')
})

test('gateway environment status route returns 404 for unknown profiles', () => {
  const output = runWithTempDataDir<{ status: number; body: { error: string } }>(`
    const routeMod = await import('./src/app/api/gateways/[id]/environments/[environmentId]/route')
    const route = routeMod.default || routeMod
    const response = await route.GET(
      new Request('http://local/api/gateways/missing/environments/gateway'),
      { params: Promise.resolve({ id: 'missing', environmentId: 'gateway' }) },
    )
    console.log(JSON.stringify({ status: response.status, body: await response.json() }))
  `, { prefix: 'swarmclaw-gateway-environment-status-route-test-' })

  assert.equal(output.status, 404)
  assert.equal(output.body.error, 'Not found')
})

test('gateway fleet route reports empty totals when no OpenClaw profiles exist', () => {
  const output = runWithTempDataDir<{
    status: number
    body: { gateways: unknown[]; totals: { gatewayCount: number; nodeCount: number; hasErrors: boolean } }
  }>(`
    const routeMod = await import('./src/app/api/gateways/fleet/route')
    const route = routeMod.default || routeMod
    const response = await route.GET(new Request('http://local/api/gateways/fleet'))
    console.log(JSON.stringify({ status: response.status, body: await response.json() }))
  `, { prefix: 'swarmclaw-gateway-fleet-route-test-' })

  assert.equal(output.status, 200)
  assert.equal(output.body.gateways.length, 0)
  assert.equal(output.body.totals.gatewayCount, 0)
  assert.equal(output.body.totals.nodeCount, 0)
  assert.equal(output.body.totals.hasErrors, false)
})
