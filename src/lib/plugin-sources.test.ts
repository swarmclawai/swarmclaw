import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getPluginSourceLabel,
  inferPluginInstallSourceFromUrl,
  inferPluginPublisherSourceFromUrl,
  isMarketplaceInstallSource,
  normalizePluginCatalogSource,
  normalizePluginInstallSource,
  normalizePluginPublisherSource,
} from './plugin-sources'

describe('plugin source helpers', () => {
  it('normalizes publisher, catalog, and install source values', () => {
    assert.equal(normalizePluginPublisherSource('SwarmForge'), 'swarmforge')
    assert.equal(normalizePluginCatalogSource('swarmclaw-site'), 'swarmclaw-site')
    assert.equal(normalizePluginInstallSource('ClawHub'), 'clawhub')
    assert.equal(normalizePluginInstallSource('unknown-source'), undefined)
  })

  it('infers plugin provenance from known marketplace URLs', () => {
    assert.equal(
      inferPluginPublisherSourceFromUrl('https://raw.githubusercontent.com/swarmclawai/swarmforge/main/tool-logger.js'),
      'swarmforge',
    )
    assert.equal(
      inferPluginInstallSourceFromUrl('https://clawhub.ai/skills/openclaw-gmail'),
      'clawhub',
    )
    assert.equal(
      inferPluginPublisherSourceFromUrl('https://swarmclaw.ai/plugins/demo.js'),
      'swarmclaw',
    )
  })

  it('labels marketplace sources consistently', () => {
    assert.equal(isMarketplaceInstallSource('swarmclaw-site'), true)
    assert.equal(isMarketplaceInstallSource('manual'), false)
    assert.equal(getPluginSourceLabel('swarmclaw-site'), 'SwarmClaw Site')
    assert.equal(getPluginSourceLabel('swarmforge'), 'SwarmForge')
  })
})
