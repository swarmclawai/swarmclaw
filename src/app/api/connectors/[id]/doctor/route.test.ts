import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('connector doctor route rejects malformed JSON with a 400', () => {
  const output = runWithTempDataDir<{
    status: number
    payload: { error?: string }
  }>(`
    const repoMod = await import('./src/lib/server/connectors/connector-repository')
    const routeMod = await import('./src/app/api/connectors/[id]/doctor/route')
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    repo.saveConnectors({
      conn_1: {
        id: 'conn_1',
        name: 'Doctor Test',
        platform: 'discord',
        agentId: 'agent_1',
        chatroomId: null,
        credentialId: null,
        config: {},
        isEnabled: true,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const response = await route.POST(new Request('http://local/api/connectors/conn_1/doctor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json',
    }), { params: Promise.resolve({ id: 'conn_1' }) })

    console.log(JSON.stringify({
      status: response.status,
      payload: await response.json(),
    }))
  `, { prefix: 'swarmclaw-connector-doctor-route-' })

  assert.equal(output.status, 400)
  assert.equal(output.payload.error, 'Invalid or missing request body')
})

test('connector doctor route returns a preview report for valid input', () => {
  const output = runWithTempDataDir<{
    status: number
    payload: { warnings?: string[]; policy?: { mode?: string } }
  }>(`
    const repoMod = await import('./src/lib/server/connectors/connector-repository')
    const routeMod = await import('./src/app/api/connectors/[id]/doctor/route')
    const repo = repoMod.default || repoMod
    const route = routeMod.default || routeMod

    repo.saveConnectors({
      conn_1: {
        id: 'conn_1',
        name: 'Doctor Test',
        platform: 'discord',
        agentId: 'agent_1',
        chatroomId: null,
        credentialId: null,
        config: {},
        isEnabled: true,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const response = await route.POST(new Request('http://local/api/connectors/conn_1/doctor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sampleMsg: {
          channelId: 'channel-1',
          channelName: 'general',
          senderId: 'user-1',
          senderName: 'User',
          text: 'hello',
        },
      }),
    }), { params: Promise.resolve({ id: 'conn_1' }) })

    console.log(JSON.stringify({
      status: response.status,
      payload: await response.json(),
    }))
  `, { prefix: 'swarmclaw-connector-doctor-route-' })

  assert.equal(output.status, 200)
  assert.ok(Array.isArray(output.payload.warnings))
  assert.ok(output.payload.policy)
})
