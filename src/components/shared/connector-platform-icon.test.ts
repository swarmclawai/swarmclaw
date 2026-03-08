import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getConnectorPlatformLabel,
  resolveConnectorPlatformMeta,
} from './connector-platform-icon'

describe('connector platform metadata', () => {
  it('resolves legacy connector platforms used by stored runtime data', () => {
    assert.deepEqual(resolveConnectorPlatformMeta('webchat'), {
      label: 'Web Chat',
      color: '#0EA5E9',
    })
    assert.deepEqual(resolveConnectorPlatformMeta('mockmail'), {
      label: 'MockMail',
      color: '#7C3AED',
    })
  })

  it('falls back safely for unknown connector platform strings', () => {
    assert.deepEqual(resolveConnectorPlatformMeta('custom-bridge'), {
      label: 'Custom Bridge',
      color: '#64748B',
    })
    assert.equal(getConnectorPlatformLabel('custom-bridge'), 'Custom Bridge')
  })
})
