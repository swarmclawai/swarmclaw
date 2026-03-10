import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AGENT_REGRESSION_SCENARIOS,
  DEFAULT_AGENT_REGRESSION_SCENARIO_IDS,
  resolveRegressionApprovalSettings,
  resolveRegressionPlugins,
  scoreAssertions,
} from './agent-regression'

describe('agent regression helpers', () => {
  it('keeps approval mode settings inert after approval queue removal', () => {
    assert.deepEqual(resolveRegressionApprovalSettings('manual'), {})
    assert.deepEqual(resolveRegressionApprovalSettings('auto'), {})
    assert.deepEqual(resolveRegressionApprovalSettings('off'), {})
  })

  it('scores scenarios from assertion weights instead of prose', () => {
    const scored = scoreAssertions([
      { name: 'artifact exists', passed: true, weight: 2 },
      { name: 'exact token preserved', passed: false, weight: 3 },
      { name: 'delegate used', passed: true },
    ])

    assert.deepEqual(scored, {
      score: 3,
      maxScore: 6,
      status: 'failed',
    })
  })

  it('includes the extended signup, secrets, email, and human-verification scenarios', () => {
    const ids = AGENT_REGRESSION_SCENARIOS.map((scenario) => scenario.id)
    assert.deepEqual(ids, [
      'approval-resume',
      'delegate-literal-artifact',
      'schedule-script',
      'open-ended-iteration',
      'mock-signup-secret-email',
      'human-verified-signup',
      'research-build-deploy',
      'blackboard-orchestrator-fit',
      'tool-call-efficiency',
      'file-creation-followthrough',
      'knowledge-first-file',
    ])
  })

  it('keeps exploratory scenarios out of the default suite score path', () => {
    assert.ok(DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('research-build-deploy'))
    assert.ok(!DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('blackboard-orchestrator-fit'))
  })

  it('can resolve regressions against the agent capability set instead of injected scenario plugins', () => {
    const resolved = resolveRegressionPlugins(
      ['delegate', 'browser', 'manage_secrets', 'email'],
      {
        plugins: ['codex_cli', 'browser', 'manage_secrets', 'files'],
      },
      'agent',
    )

    assert.deepEqual(resolved.requiredPlugins, ['delegate', 'browser', 'manage_secrets', 'email'])
    assert.deepEqual(resolved.effectivePlugins, ['codex_cli', 'browser', 'manage_secrets', 'files'])
    assert.deepEqual(resolved.missingPlugins, ['email'])
  })
})
