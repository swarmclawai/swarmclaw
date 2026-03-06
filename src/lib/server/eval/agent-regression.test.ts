import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AGENT_REGRESSION_SCENARIOS, resolveRegressionApprovalSettings, scoreAssertions } from './agent-regression'

describe('agent regression helpers', () => {
  it('maps approval modes onto deterministic platform settings', () => {
    assert.deepEqual(resolveRegressionApprovalSettings('manual'), {
      approvalsEnabled: true,
      approvalAutoApproveCategories: [],
    })
    assert.deepEqual(resolveRegressionApprovalSettings('auto'), {
      approvalsEnabled: true,
      approvalAutoApproveCategories: ['tool_access'],
    })
    assert.deepEqual(resolveRegressionApprovalSettings('off'), {
      approvalsEnabled: false,
      approvalAutoApproveCategories: [],
    })
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
    ])
  })
})
