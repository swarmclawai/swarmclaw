import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeTaskQualityGate } from './task-quality-gate'

test('normalizeTaskQualityGate uses defaults when unset', () => {
  const gate = normalizeTaskQualityGate(undefined, undefined)
  assert.equal(gate.enabled, true)
  assert.equal(gate.minResultChars, 80)
  assert.equal(gate.minEvidenceItems, 2)
  assert.equal(gate.requireVerification, false)
  assert.equal(gate.requireArtifact, false)
  assert.equal(gate.requireReport, false)
})

test('normalizeTaskQualityGate respects app settings defaults', () => {
  const gate = normalizeTaskQualityGate(null, {
    taskQualityGateEnabled: false,
    taskQualityGateMinResultChars: 120,
    taskQualityGateMinEvidenceItems: 1,
    taskQualityGateRequireVerification: true,
  })
  assert.equal(gate.enabled, false)
  assert.equal(gate.minResultChars, 120)
  assert.equal(gate.minEvidenceItems, 1)
  assert.equal(gate.requireVerification, true)
})

test('normalizeTaskQualityGate allows per-task overrides on top of settings', () => {
  const gate = normalizeTaskQualityGate({
    enabled: true,
    minResultChars: 64,
    minEvidenceItems: 3,
    requireArtifact: true,
  }, {
    taskQualityGateEnabled: false,
    taskQualityGateMinResultChars: 120,
    taskQualityGateMinEvidenceItems: 1,
    taskQualityGateRequireArtifact: false,
  })
  assert.equal(gate.enabled, true)
  assert.equal(gate.minResultChars, 64)
  assert.equal(gate.minEvidenceItems, 3)
  assert.equal(gate.requireArtifact, true)
})
