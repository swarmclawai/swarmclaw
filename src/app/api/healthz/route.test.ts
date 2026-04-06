import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GET } from '@/app/api/healthz/route'

test('GET /api/healthz returns an ok payload', async () => {
  const response = await GET()
  assert.equal(response.status, 200)

  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.service, 'swarmclaw')
  assert.equal(typeof payload.time, 'number')
})
