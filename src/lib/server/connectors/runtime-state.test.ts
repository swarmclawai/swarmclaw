import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

const originalEnv = {
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let mod: typeof import('@/lib/server/connectors/runtime-state')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/connectors/runtime-state')
})

after(() => {
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
})

// ---------------------------------------------------------------------------
// getConnectorRuntimeState
// ---------------------------------------------------------------------------

describe('getConnectorRuntimeState', () => {
  it('returns object with all expected Map keys', () => {
    const state = mod.getConnectorRuntimeState()
    assert.ok(state.running instanceof Map)
    assert.ok(state.lastInboundChannelByConnector instanceof Map)
    assert.ok(state.lastInboundTimeByConnector instanceof Map)
    assert.ok(state.locks instanceof Map)
    assert.ok(state.generationCounter instanceof Map)
    assert.ok(state.scheduledFollowups instanceof Map)
    assert.ok(state.recentInboundByKey instanceof Map)
    assert.ok(state.pendingInboundDebounce instanceof Map)
    assert.ok(state.scheduledFollowupByDedupe instanceof Map)
    assert.ok(state.reconnectStates instanceof Map)
    assert.ok(state.recentOutbound instanceof Map)
    assert.ok(state.routeMessageHandlerRef)
    assert.equal(typeof state.routeMessageHandlerRef.current, 'function')
  })

  it('returns the same instance on repeated calls (singleton)', () => {
    const a = mod.getConnectorRuntimeState()
    const b = mod.getConnectorRuntimeState()
    assert.equal(a, b)
  })
})

// ---------------------------------------------------------------------------
// pruneConnectorTrackingState
// ---------------------------------------------------------------------------

describe('pruneConnectorTrackingState', () => {
  it('removes stale entries and retains live ones', () => {
    const state = mod.getConnectorRuntimeState()

    // Seed tracking maps with stale + live IDs
    state.lastInboundChannelByConnector.set('live-1', 'channel-a')
    state.lastInboundChannelByConnector.set('stale-1', 'channel-b')
    state.lastInboundTimeByConnector.set('live-1', Date.now())
    state.lastInboundTimeByConnector.set('stale-2', Date.now())
    state.generationCounter.set('live-1', 5)
    state.generationCounter.set('stale-1', 3)

    const liveIds = new Set(['live-1'])
    const removed = mod.pruneConnectorTrackingState(liveIds)

    // Verify stale entries are gone
    assert.equal(state.lastInboundChannelByConnector.has('stale-1'), false)
    assert.equal(state.lastInboundTimeByConnector.has('stale-2'), false)
    assert.equal(state.generationCounter.has('stale-1'), false)

    // Verify live entries are retained
    assert.equal(state.lastInboundChannelByConnector.get('live-1'), 'channel-a')
    assert.ok(state.lastInboundTimeByConnector.has('live-1'))
    assert.equal(state.generationCounter.get('live-1'), 5)

    // Removed count: stale-1 from channel + stale-2 from time + stale-1 from gen = 3
    assert.equal(removed, 3)
  })

  it('removes all entries when liveIds is empty', () => {
    const state = mod.getConnectorRuntimeState()

    state.lastInboundChannelByConnector.set('a', 'ch')
    state.lastInboundTimeByConnector.set('a', 1)
    state.generationCounter.set('a', 1)

    const removed = mod.pruneConnectorTrackingState(new Set())

    assert.equal(state.lastInboundChannelByConnector.size, 0)
    assert.equal(state.lastInboundTimeByConnector.size, 0)
    assert.equal(state.generationCounter.size, 0)
    assert.ok(removed >= 3)
  })

  it('returns 0 when all IDs are live', () => {
    const state = mod.getConnectorRuntimeState()

    // Clear first
    state.lastInboundChannelByConnector.clear()
    state.lastInboundTimeByConnector.clear()
    state.generationCounter.clear()

    state.lastInboundChannelByConnector.set('x', 'ch')
    state.lastInboundTimeByConnector.set('x', 1)
    state.generationCounter.set('x', 1)

    const removed = mod.pruneConnectorTrackingState(new Set(['x']))
    assert.equal(removed, 0)

    // Entries still present
    assert.equal(state.lastInboundChannelByConnector.has('x'), true)
    assert.equal(state.lastInboundTimeByConnector.has('x'), true)
    assert.equal(state.generationCounter.has('x'), true)
  })
})
