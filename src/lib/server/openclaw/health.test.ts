import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveOpenClawHttpProbeStatus } from './health'

test('treats missing /v1/models as optional when chat completions works', () => {
  const result = resolveOpenClawHttpProbeStatus({
    modelsStatus: 404,
    chatStatus: 200,
    warnings: ['OpenAI-compatible models endpoint failed: OpenClaw endpoint path is invalid (404).'],
    warningHint: 'Point to the gateway root/ws URL and let SwarmClaw normalize it, or use an explicit /v1 endpoint.',
  })

  assert.equal(result.httpCompatible, true)
  assert.equal(result.modelsEndpointOptional, true)
  assert.equal(result.warning, undefined)
  assert.equal(result.hint, undefined)
})

test('keeps chat failures as real warnings even when /v1/models is missing', () => {
  const result = resolveOpenClawHttpProbeStatus({
    modelsStatus: 404,
    chatStatus: 500,
    warnings: [
      'OpenAI-compatible models endpoint failed: OpenClaw endpoint path is invalid (404).',
      'OpenAI-compatible chat endpoint failed: OpenClaw endpoint returned HTTP 500.',
    ],
    warningHint: 'Ensure this is an OpenAI-compatible chat endpoint exposed by the OpenClaw gateway.',
  })

  assert.equal(result.httpCompatible, false)
  assert.equal(result.modelsEndpointOptional, false)
  assert.match(result.warning || '', /chat endpoint failed/i)
  assert.equal(result.hint, 'Ensure this is an OpenAI-compatible chat endpoint exposed by the OpenClaw gateway.')
})
