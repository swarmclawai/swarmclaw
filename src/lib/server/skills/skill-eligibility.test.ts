import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRequirements, clearBinaryCache } from '@/lib/server/skills/skill-eligibility'
import type { SkillRequirements } from '@/types'

describe('evaluateRequirements', () => {
  beforeEach(() => {
    clearBinaryCache()
  })

  it('returns eligible when no requirements', () => {
    const result = evaluateRequirements({})
    assert.equal(result.eligible, true)
    assert.equal(result.reasons.length, 0)
  })

  it('passes when required binary exists (node)', () => {
    const result = evaluateRequirements({ bins: ['node'] })
    assert.equal(result.eligible, true)
    assert.equal(result.missingBins.length, 0)
  })

  it('fails when required binary is missing', () => {
    const result = evaluateRequirements({ bins: ['nonexistent_binary_xyz_123'] })
    assert.equal(result.eligible, false)
    assert.deepEqual(result.missingBins, ['nonexistent_binary_xyz_123'])
    assert.ok(result.reasons[0].includes('Missing binaries'))
  })

  it('handles anyBins groups — passes when at least one exists', () => {
    const result = evaluateRequirements({
      anyBins: [['node', 'nonexistent_abc']],
    })
    assert.equal(result.eligible, true)
    assert.equal(result.missingAnyBins.length, 0)
  })

  it('handles anyBins groups — fails when none exist', () => {
    const result = evaluateRequirements({
      anyBins: [['nonexistent_a', 'nonexistent_b']],
    })
    assert.equal(result.eligible, false)
    assert.equal(result.missingAnyBins.length, 1)
  })

  it('checks environment variables', () => {
    const result = evaluateRequirements({ env: ['VERY_UNLIKELY_ENV_VAR_XYZ'] })
    assert.equal(result.eligible, false)
    assert.deepEqual(result.missingEnv, ['VERY_UNLIKELY_ENV_VAR_XYZ'])
  })

  it('passes env check when env var is set', () => {
    // PATH is always set
    const result = evaluateRequirements({ env: ['PATH'] })
    assert.equal(result.eligible, true)
    assert.equal(result.missingEnv.length, 0)
  })

  it('checks OS compatibility — passes on current platform', () => {
    const result = evaluateRequirements({ os: [process.platform] })
    assert.equal(result.eligible, true)
    assert.equal(result.unsupportedOs, false)
  })

  it('checks OS compatibility — fails on wrong platform', () => {
    const result = evaluateRequirements({ os: ['nonexistent_os'] })
    assert.equal(result.eligible, false)
    assert.equal(result.unsupportedOs, true)
  })

  it('combines multiple failing checks', () => {
    const req: SkillRequirements = {
      bins: ['nonexistent_bin_xyz'],
      env: ['NONEXISTENT_ENV_ABC'],
      os: ['nonexistent_os'],
    }
    const result = evaluateRequirements(req)
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.length >= 3)
    assert.ok(result.missingBins.length > 0)
    assert.ok(result.missingEnv.length > 0)
    assert.equal(result.unsupportedOs, true)
  })
})
