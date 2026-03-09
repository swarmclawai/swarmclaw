import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALL_TOOLS } from '@/lib/tool-definitions'
import { getDefaultAgentPluginIds, resolveAgentPluginSelection } from './agent-default-tools'

describe('agent default tools', () => {
  it('only includes known tool ids', () => {
    const knownToolIds = new Set(ALL_TOOLS.map((tool) => tool.id))
    const defaults = getDefaultAgentPluginIds()

    assert.ok(defaults.length > 0)
    assert.deepEqual(defaults, Array.from(new Set(defaults)))
    assert.equal(defaults.every((toolId) => knownToolIds.has(toolId)), true)
  })

  it('uses the shared defaults when a request never chose tools', () => {
    assert.deepEqual(
      resolveAgentPluginSelection({
        hasExplicitPlugins: false,
        hasExplicitTools: false,
        plugins: [],
        tools: undefined,
      }),
      getDefaultAgentPluginIds(),
    )
  })

  it('preserves an explicit empty plugins selection', () => {
    assert.deepEqual(
      resolveAgentPluginSelection({
        hasExplicitPlugins: true,
        hasExplicitTools: false,
        plugins: [],
        tools: ['web'],
      }),
      [],
    )
  })

  it('accepts explicit legacy tools selections', () => {
    assert.deepEqual(
      resolveAgentPluginSelection({
        hasExplicitPlugins: false,
        hasExplicitTools: true,
        plugins: [],
        tools: ['web', 'browser'],
      }),
      ['web', 'browser'],
    )
  })
})
