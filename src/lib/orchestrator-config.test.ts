import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOrchestratorProviderEligible, normalizeOrchestratorConfig } from './orchestrator-config'

describe('orchestrator-config', () => {
  it('marks CLI and OpenClaw providers as ineligible', () => {
    assert.equal(isOrchestratorProviderEligible('openai'), true)
    assert.equal(isOrchestratorProviderEligible('openclaw'), false)
    assert.equal(isOrchestratorProviderEligible('hermes'), false)
    assert.equal(isOrchestratorProviderEligible('codex-cli'), false)
  })

  it('normalizes persisted config and disables unsupported providers', () => {
    const supported = normalizeOrchestratorConfig({
      provider: 'openai',
      orchestratorEnabled: true,
      orchestratorMission: ' Keep things healthy ',
      orchestratorWakeInterval: '15m',
      orchestratorGovernance: 'approval-required',
      orchestratorMaxCyclesPerDay: 8.9,
    })
    assert.deepEqual(supported, {
      orchestratorEnabled: true,
      orchestratorMission: 'Keep things healthy',
      orchestratorWakeInterval: '15m',
      orchestratorGovernance: 'approval-required',
      orchestratorMaxCyclesPerDay: 8,
    })

    const unsupported = normalizeOrchestratorConfig({
      provider: 'openclaw',
      orchestratorEnabled: true,
      orchestratorMission: 'Will be preserved',
      orchestratorWakeInterval: '',
      orchestratorGovernance: 'notify-only',
      orchestratorMaxCyclesPerDay: -2,
    })
    assert.deepEqual(unsupported, {
      orchestratorEnabled: false,
      orchestratorMission: 'Will be preserved',
      orchestratorWakeInterval: null,
      orchestratorGovernance: 'notify-only',
      orchestratorMaxCyclesPerDay: null,
    })
  })
})
