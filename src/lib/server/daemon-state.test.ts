import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSessionHeartbeatHealthDedupKey,
  shouldSuppressSyntheticAgentHealthAlert,
  shouldSuppressSessionHeartbeatHealthAlert,
} from './daemon-state'

describe('daemon heartbeat health alerts', () => {
  it('suppresses synthetic workbench and benchmark sessions', () => {
    assert.equal(shouldSuppressSessionHeartbeatHealthAlert({
      id: 'wb-123',
      name: 'Workbench wb-123',
      user: 'workbench',
      shortcutForAgentId: null,
    }), true)

    assert.equal(shouldSuppressSessionHeartbeatHealthAlert({
      id: 'agent-chat-cmp-1',
      name: 'Assistant Benchmark seo_content',
      user: 'default',
      shortcutForAgentId: 'cmp-sc-2026-03-08t19-15-21-415z-seo_content-agent',
    }), true)

    assert.equal(shouldSuppressSessionHeartbeatHealthAlert({
      id: 'agent-chat-real-1',
      name: 'Molly',
      user: 'default',
      shortcutForAgentId: 'agent-real-1',
    }), false)
  })

  it('builds stable per-session heartbeat dedup keys', () => {
    assert.equal(
      buildSessionHeartbeatHealthDedupKey('session-123', 'stale'),
      'health-alert:session-heartbeat:stale:session-123',
    )
    assert.equal(
      buildSessionHeartbeatHealthDedupKey('session-123', 'auto-disabled'),
      'health-alert:session-heartbeat:auto-disabled:session-123',
    )
  })

  it('suppresses synthetic benchmark agent health alerts', () => {
    assert.equal(shouldSuppressSyntheticAgentHealthAlert('wb-wb-20260308190158-blog-outline'), true)
    assert.equal(shouldSuppressSyntheticAgentHealthAlert('cmp-oc-2026-03-08t19-15-21-755z-agent'), true)
    assert.equal(shouldSuppressSyntheticAgentHealthAlert('agent-real-123'), false)
  })
})
