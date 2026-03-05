import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMainMissionSession } from './session-run-manager'

describe('isMainMissionSession', () => {
  it('accepts agent-thread sessions', () => {
    assert.equal(
      isMainMissionSession({ id: 'agent-thread-agent_coder-123', name: 'agent-thread:agent_coder', sessionType: 'human' }),
      true,
    )
  })

  it('accepts orchestrated sessions', () => {
    assert.equal(
      isMainMissionSession({ id: 'agent-thread-worker-1', name: 'agent-thread:worker', sessionType: 'orchestrated' }),
      true,
    )
  })

  it('rejects regular chat sessions', () => {
    assert.equal(
      isMainMissionSession({ id: 'abc123', name: 'New Chat', sessionType: 'human' }),
      false,
    )
  })
})
