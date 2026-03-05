import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMainMissionSession } from './session-run-manager'

describe('isMainMissionSession', () => {
  it('accepts explicit main sessions', () => {
    assert.equal(isMainMissionSession({ id: 'main-user', name: '__main__' }), true)
  })

  it('rejects human agent-thread sessions', () => {
    assert.equal(
      isMainMissionSession({ id: 'agent-thread-agent_coder-123', name: 'agent-thread:agent_coder', sessionType: 'human' }),
      false,
    )
  })

  it('accepts orchestrated sessions', () => {
    assert.equal(
      isMainMissionSession({ id: 'agent-thread-worker-1', name: 'agent-thread:worker', sessionType: 'orchestrated' }),
      true,
    )
  })
})
