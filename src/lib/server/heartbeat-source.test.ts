import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isHeartbeatSource, isInternalHeartbeatRun } from './heartbeat-source'

describe('heartbeat-source', () => {
  it('treats scheduled heartbeat polls as heartbeat traffic', () => {
    assert.equal(isHeartbeatSource('heartbeat'), true)
    assert.equal(isInternalHeartbeatRun(true, 'heartbeat'), true)
  })

  it('treats wake-triggered heartbeat polls as heartbeat traffic', () => {
    assert.equal(isHeartbeatSource('heartbeat-wake'), true)
    assert.equal(isInternalHeartbeatRun(true, 'heartbeat-wake'), true)
  })

  it('does not classify other sources as heartbeat traffic', () => {
    assert.equal(isHeartbeatSource('task'), false)
    assert.equal(isHeartbeatSource('chat'), false)
    assert.equal(isInternalHeartbeatRun(false, 'heartbeat'), false)
    assert.equal(isInternalHeartbeatRun(true, 'task'), false)
  })
})
