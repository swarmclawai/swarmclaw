import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import '@/lib/server/builtin-plugins'
import { collectCapabilityDescriptions, listNativeCapabilities } from '@/lib/server/native-capabilities'
import { getPluginManager } from '@/lib/server/plugins'

describe('native capabilities', () => {
  it('keeps platform-owned built-ins out of PluginManager listings', () => {
    const plugins = getPluginManager().listPlugins()
    const nativeIds = new Set(listNativeCapabilities().map((entry) => entry.filename))

    assert.equal(nativeIds.has('memory'), true)
    assert.equal(nativeIds.has('connectors'), true)
    assert.equal(plugins.some((entry) => entry.filename === 'memory'), false)
    assert.equal(plugins.some((entry) => entry.filename === 'connectors'), false)
    assert.equal(plugins.some((entry) => entry.filename === 'email'), true)
  })

  it('still contributes native capability descriptions to prompt assembly', () => {
    const lines = collectCapabilityDescriptions(['memory', 'connectors'])
    assert.equal(lines.some((line) => line.includes('long-term memory')), true)
    assert.equal(lines.some((line) => line.includes('manage messaging channels')), true)
  })
})
