import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getEnabledExtensionIds,
  getEnabledToolIds,
  isExternalExtensionId,
  mergeCapabilityIds,
  normalizeCapabilitySelection,
  splitCapabilityIds,
} from '@/lib/capability-selection'

describe('capability selection helpers', () => {
  it('splits legacy plugin arrays into tools and extensions', () => {
    const result = splitCapabilityIds(['memory', 'custom-tool.js', 'connectors', 'custom-tool.js'])
    assert.deepEqual(result.tools, ['memory', 'connectors'])
    assert.deepEqual(result.extensions, ['custom-tool.js'])
  })

  it('normalizes tools and extensions without synthesizing legacy compatibility fields', () => {
    const result = normalizeCapabilitySelection({
      tools: ['memory'],
      extensions: ['custom-tool.mjs'],
    })
    assert.deepEqual(result.tools, ['memory'])
    assert.deepEqual(result.extensions, ['custom-tool.mjs'])
  })

  it('reads enabled tool and extension ids from the canonical fields only', () => {
    const selection = {
      tools: ['schedule'],
      extensions: ['demo.js'],
    }
    assert.deepEqual(getEnabledToolIds(selection), ['schedule'])
    assert.deepEqual(getEnabledExtensionIds(selection), ['demo.js'])
  })

  it('detects external extension ids by filename', () => {
    assert.equal(isExternalExtensionId('demo.js'), true)
    assert.equal(isExternalExtensionId('demo.mjs'), true)
    assert.equal(isExternalExtensionId('memory'), false)
    assert.deepEqual(mergeCapabilityIds(['memory'], ['demo.js']), ['memory', 'demo.js'])
  })
})
