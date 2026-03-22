import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('provider route upserts builtin override records for enablement changes', () => {
  const output = runWithTempDataDir<{
    providerConfig: {
      id: string
      type: string
      name: string
      isEnabled: boolean
      requiresApiKey: boolean
    }
    responsePayload: {
      id: string
      type: string
      isEnabled: boolean
    }
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const routeMod = await import('./src/app/api/providers/[id]/route')
    const storage = storageMod.default || storageMod
    const route = routeMod.default || routeMod

    const response = await route.PUT(
      new Request('http://local/api/providers/openai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isEnabled: false }),
      }),
      { params: Promise.resolve({ id: 'openai' }) },
    )

    console.log(JSON.stringify({
      providerConfig: storage.loadProviderConfigs().openai,
      responsePayload: await response.json(),
    }))
  `, { prefix: 'swarmclaw-provider-route-test-' })

  assert.equal(output.providerConfig.id, 'openai')
  assert.equal(output.providerConfig.type, 'builtin')
  assert.equal(output.providerConfig.name, 'OpenAI')
  assert.equal(output.providerConfig.isEnabled, false)
  assert.equal(output.providerConfig.requiresApiKey, true)
  assert.equal(output.responsePayload.id, 'openai')
  assert.equal(output.responsePayload.type, 'builtin')
  assert.equal(output.responsePayload.isEnabled, false)
})
