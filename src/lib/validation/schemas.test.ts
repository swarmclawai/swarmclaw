import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentCreateSchema } from './schemas'

describe('AgentCreateSchema', () => {
  it('defaults platformAssignScope to self', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Solo Agent',
      provider: 'openai',
    })

    assert.equal(parsed.platformAssignScope, 'self')
  })

  it('accepts explicit all-scope delegation without relying on legacy orchestrator flags', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Coordinator',
      provider: 'openai',
      platformAssignScope: 'all',
      isOrchestrator: false,
    })

    assert.equal(parsed.platformAssignScope, 'all')
    assert.equal(parsed.isOrchestrator, false)
  })
})
