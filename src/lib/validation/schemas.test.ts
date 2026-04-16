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

  it('accepts orchestrator config and isolated session reset mode for eligible providers', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Operator',
      provider: 'openai',
      orchestratorEnabled: true,
      orchestratorMission: ' Keep the platform healthy ',
      orchestratorWakeInterval: '5m',
      orchestratorGovernance: 'notify-only',
      orchestratorMaxCyclesPerDay: 12,
      sessionResetMode: 'isolated',
    })

    assert.equal(parsed.orchestratorEnabled, true)
    assert.equal(parsed.orchestratorMission, ' Keep the platform healthy ')
    assert.equal(parsed.orchestratorWakeInterval, '5m')
    assert.equal(parsed.orchestratorGovernance, 'notify-only')
    assert.equal(parsed.orchestratorMaxCyclesPerDay, 12)
    assert.equal(parsed.sessionResetMode, 'isolated')
  })

  it('preserves heartbeat goal/nextAction/target/prompt fields without dropping them', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Daily Reporter',
      provider: 'openai',
      heartbeatPrompt: 'Custom prompt',
      heartbeatGoal: 'Report the day-of-week',
      heartbeatNextAction: 'Reply with weekday',
      heartbeatTarget: 'last',
    })

    assert.equal(parsed.heartbeatPrompt, 'Custom prompt')
    assert.equal(parsed.heartbeatGoal, 'Report the day-of-week')
    assert.equal(parsed.heartbeatNextAction, 'Reply with weekday')
    assert.equal(parsed.heartbeatTarget, 'last')
  })

  it('accepts executeConfig for sandboxed execute defaults', () => {
    const parsed = AgentCreateSchema.parse({
      name: 'Builder',
      provider: 'openai',
      executeConfig: {
        backend: 'sandbox',
        network: { enabled: true },
        timeout: 45,
      },
    })

    assert.equal(parsed.executeConfig?.backend, 'sandbox')
    assert.equal(parsed.executeConfig?.network?.enabled, true)
    assert.equal(parsed.executeConfig?.timeout, 45)
  })
})
