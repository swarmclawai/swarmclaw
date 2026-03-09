import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

// provider-health uses globalThis to store state — we can import directly
// since the pure logic functions don't need DATA_DIR. But spawnSync is used
// by commandExists/delegateToolReady, so rankDelegatesByHealth will hit
// the real filesystem. We test pure state functions here.

let providerHealth: typeof import('./provider-health')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  providerHealth = await import('./provider-health')
})

describe('provider-health', () => {
  // -------------------------------------------------------------------------
  // markProviderFailure / markProviderSuccess / isProviderCoolingDown
  // -------------------------------------------------------------------------

  it('fresh provider is not cooling down', () => {
    assert.equal(providerHealth.isProviderCoolingDown('fresh-provider-xyz'), false)
  })

  it('markProviderFailure puts provider into cooldown', () => {
    providerHealth.markProviderFailure('test-fail-1', 'connection refused')
    assert.equal(providerHealth.isProviderCoolingDown('test-fail-1'), true)
  })

  it('markProviderSuccess clears cooldown', () => {
    providerHealth.markProviderFailure('test-recover-1', 'timeout')
    assert.equal(providerHealth.isProviderCoolingDown('test-recover-1'), true)

    providerHealth.markProviderSuccess('test-recover-1')
    assert.equal(providerHealth.isProviderCoolingDown('test-recover-1'), false)
  })

  it('multiple failures increase cooldown (exponential backoff)', () => {
    const id = 'test-backoff-1'
    providerHealth.markProviderFailure(id, 'err')
    const snap1 = providerHealth.getProviderHealthSnapshot()[id]

    providerHealth.markProviderFailure(id, 'err')
    const snap2 = providerHealth.getProviderHealthSnapshot()[id]

    providerHealth.markProviderFailure(id, 'err')
    const snap3 = providerHealth.getProviderHealthSnapshot()[id]

    assert.equal(snap1.failures, 1)
    assert.equal(snap2.failures, 2)
    assert.equal(snap3.failures, 3)

    // Cooldown should increase with more failures
    const cooldown1 = (snap1.cooldownUntil ?? 0) - (snap1.lastFailureAt ?? 0)
    const cooldown2 = (snap2.cooldownUntil ?? 0) - (snap2.lastFailureAt ?? 0)
    const cooldown3 = (snap3.cooldownUntil ?? 0) - (snap3.lastFailureAt ?? 0)
    assert.ok(cooldown2 > cooldown1, 'cooldown2 > cooldown1')
    assert.ok(cooldown3 > cooldown2, 'cooldown3 > cooldown2')
  })

  it('failure count is capped at 50', () => {
    const id = 'test-cap-1'
    for (let i = 0; i < 60; i++) {
      providerHealth.markProviderFailure(id, `err-${i}`)
    }
    const snap = providerHealth.getProviderHealthSnapshot()[id]
    assert.equal(snap.failures, 50)
  })

  it('error message is truncated to 500 chars', () => {
    const id = 'test-trunc-1'
    const longError = 'x'.repeat(1000)
    providerHealth.markProviderFailure(id, longError)
    const snap = providerHealth.getProviderHealthSnapshot()[id]
    assert.equal(snap.lastError?.length, 500)
  })

  it('success resets failure count to 0', () => {
    const id = 'test-reset-1'
    providerHealth.markProviderFailure(id, 'err')
    providerHealth.markProviderFailure(id, 'err')
    providerHealth.markProviderFailure(id, 'err')
    providerHealth.markProviderSuccess(id)
    const snap = providerHealth.getProviderHealthSnapshot()[id]
    assert.equal(snap.failures, 0)
    assert.equal(snap.cooldownUntil, undefined)
  })

  it('success preserves lastError and lastFailureAt from previous failures', () => {
    const id = 'test-preserve-1'
    providerHealth.markProviderFailure(id, 'original error')
    const afterFail = providerHealth.getProviderHealthSnapshot()[id]
    providerHealth.markProviderSuccess(id)
    const afterSuccess = providerHealth.getProviderHealthSnapshot()[id]

    assert.equal(afterSuccess.lastError, 'original error')
    assert.equal(afterSuccess.lastFailureAt, afterFail.lastFailureAt)
    assert.ok(afterSuccess.lastSuccessAt! > 0)
  })

  // -------------------------------------------------------------------------
  // getProviderHealthSnapshot
  // -------------------------------------------------------------------------

  it('snapshot includes coolingDown boolean', () => {
    const id = 'test-snapshot-cool'
    providerHealth.markProviderFailure(id, 'err')
    const snap = providerHealth.getProviderHealthSnapshot()
    assert.equal(snap[id].coolingDown, true)

    providerHealth.markProviderSuccess(id)
    const snap2 = providerHealth.getProviderHealthSnapshot()
    assert.equal(snap2[id].coolingDown, false)
  })

  // -------------------------------------------------------------------------
  // OPENAI_COMPATIBLE_DEFAULTS
  // -------------------------------------------------------------------------

  it('OPENAI_COMPATIBLE_DEFAULTS has expected providers', () => {
    const defaults = providerHealth.OPENAI_COMPATIBLE_DEFAULTS
    assert.ok(defaults.openai)
    assert.ok(defaults.google)
    assert.ok(defaults.deepseek)
    assert.ok(defaults.groq)
    assert.ok(defaults.together)
    assert.ok(defaults.mistral)
    assert.ok(defaults.xai)
    assert.ok(defaults.fireworks)

    // Each entry has name and defaultEndpoint
    for (const [, val] of Object.entries(defaults)) {
      assert.ok(typeof val.name === 'string' && val.name.length > 0)
      assert.ok(typeof val.defaultEndpoint === 'string' && val.defaultEndpoint.startsWith('https://'))
    }
  })
})
