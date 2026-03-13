import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentCreateSchema } from './schemas'

describe('AgentCreateSchema', () => {
  it('defaults delegation to disabled with all-target mode available', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Solo Agent',
      provider: 'openai',
    })

    assert.equal(parsed.delegationEnabled, false)
    assert.equal(parsed.delegationTargetMode, 'all')
    assert.deepEqual(parsed.delegationTargetAgentIds, [])
  })

  it('defaults heartbeat and proactive memory to enabled for new agents', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Solo Agent',
      provider: 'openai',
    })

    assert.equal(parsed.heartbeatEnabled, true)
    assert.equal(parsed.proactiveMemory, true)
  })

  it('accepts explicit delegation settings without any legacy coordination flags', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Coordinator',
      provider: 'openai',
      delegationEnabled: true,
      delegationTargetMode: 'selected',
      delegationTargetAgentIds: ['agent-a', 'agent-b'],
    })

    assert.equal(parsed.delegationEnabled, true)
    assert.equal(parsed.delegationTargetMode, 'selected')
    assert.deepEqual(parsed.delegationTargetAgentIds, ['agent-a', 'agent-b'])
  })
})
