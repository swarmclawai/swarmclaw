import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AGENT_REGRESSION_SCENARIOS,
  DEFAULT_AGENT_REGRESSION_SCENARIO_IDS,
  resolveRegressionApprovalSettings,
  resolveRegressionPlugins,
  scoreAssertions,
} from './agent-regression'

import type { RegressionAssertion } from './agent-regression'

// ---------------------------------------------------------------------------
// scoreAssertions
// ---------------------------------------------------------------------------

describe('scoreAssertions', () => {
  it('perfect score with weighted assertions', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'a', passed: true, weight: 1 },
      { name: 'b', passed: true, weight: 2 },
      { name: 'c', passed: true, weight: 3 },
      { name: 'd', passed: true, weight: 4 },
      { name: 'e', passed: true, weight: 5 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 15)
    assert.equal(result.maxScore, 15)
    assert.equal(result.status, 'passed')
  })

  it('single failure tanks status even when most pass', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'a', passed: true, weight: 1 },
      { name: 'b', passed: true, weight: 1 },
      { name: 'c', passed: true, weight: 1 },
      { name: 'd', passed: true, weight: 1 },
      { name: 'e', passed: false, weight: 1 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 4)
    assert.equal(result.maxScore, 5)
    assert.equal(result.status, 'failed')
  })

  it('zero-weight failing assertion does not affect score or status', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'high-value-1', passed: true, weight: 5 },
      { name: 'high-value-2', passed: true, weight: 5 },
      { name: 'cosmetic-check', passed: false, weight: 0 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 10)
    assert.equal(result.maxScore, 10)
    assert.equal(result.status, 'passed')
  })

  it('defaults weight to 1 when not specified', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'explicit', passed: true, weight: 3 },
      { name: 'implicit-1', passed: true },
      { name: 'implicit-2', passed: false },
    ]
    const result = scoreAssertions(assertions)
    // score: 3 (explicit) + 1 (implicit-1) = 4
    // maxScore: 3 + 1 + 1 = 5
    assert.equal(result.score, 4)
    assert.equal(result.maxScore, 5)
    assert.equal(result.status, 'failed')
  })

  it('empty assertions produce score 0/0 with passed status (vacuous truth)', () => {
    const result = scoreAssertions([])
    assert.equal(result.score, 0)
    assert.equal(result.maxScore, 0)
    assert.equal(result.status, 'passed')
  })

  it('all failures yield score 0 with failed status', () => {
    const assertions: RegressionAssertion[] = [
      { name: 'a', passed: false, weight: 2 },
      { name: 'b', passed: false, weight: 3 },
      { name: 'c', passed: false, weight: 5 },
    ]
    const result = scoreAssertions(assertions)
    assert.equal(result.score, 0)
    assert.equal(result.maxScore, 10)
    assert.equal(result.status, 'failed')
  })

  it('handles a large batch of 100 assertions correctly', () => {
    // Deterministic pseudo-random: alternate pass/fail in a pattern
    const assertions: RegressionAssertion[] = []
    let expectedScore = 0
    let expectedMaxScore = 0

    for (let i = 0; i < 100; i++) {
      const weight = (i % 7) + 1 // weights cycle 1..7
      const passed = i % 3 !== 0 // fails on every 3rd (indices 0, 3, 6, ...)
      assertions.push({ name: `assertion-${i}`, passed, weight })
      expectedMaxScore += weight
      if (passed) expectedScore += weight
    }

    const result = scoreAssertions(assertions)
    assert.equal(result.score, expectedScore)
    assert.equal(result.maxScore, expectedMaxScore)
    // At least some fail, so status should be 'failed'
    assert.equal(result.status, expectedScore === expectedMaxScore ? 'passed' : 'failed')
  })

  it('handles negative and fractional weights without clamping', () => {
    // The implementation does weight ?? 1 with no clamping, so negative
    // weights are added as-is. This test documents actual behavior.
    const assertions: RegressionAssertion[] = [
      { name: 'fractional-pass', passed: true, weight: 0.5 },
      { name: 'fractional-fail', passed: false, weight: 0.5 },
      { name: 'negative-pass', passed: true, weight: -1 },
      { name: 'zero-pass', passed: true, weight: 0 },
    ]
    const result = scoreAssertions(assertions)

    // score = 0.5 (fractional-pass) + (-1) (negative-pass) + 0 (zero-pass) = -0.5
    // maxScore = 0.5 + 0.5 + (-1) + 0 = 0
    assert.equal(result.score, -0.5)
    assert.equal(result.maxScore, 0)
    // score !== maxScore → 'failed'
    assert.equal(result.status, 'failed')
  })
})

// ---------------------------------------------------------------------------
// resolveRegressionPlugins
// ---------------------------------------------------------------------------

describe('resolveRegressionPlugins', () => {
  it('scenario mode uses scenario plugins as effective plugins', () => {
    const scenarioPlugins = ['delegate', 'browser', 'email']
    const agent = { plugins: ['delegate', 'files', 'web'] }

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'scenario')

    assert.deepEqual(result.effectivePlugins, ['delegate', 'browser', 'email'])
    assert.deepEqual(result.missingPlugins, [])
  })

  it('agent mode uses agent plugins and reports missing ones', () => {
    const scenarioPlugins = ['delegate', 'browser', 'email']
    const agent = { plugins: ['delegate', 'files', 'web'] }

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'agent')

    assert.deepEqual(result.effectivePlugins, ['delegate', 'files', 'web'])
    assert.deepEqual(result.requiredPlugins, ['delegate', 'browser', 'email'])
    // 'delegate' is present (agent has it), 'browser' and 'email' are missing
    assert.ok(result.missingPlugins.includes('browser'))
    assert.ok(result.missingPlugins.includes('email'))
    assert.ok(!result.missingPlugins.includes('delegate'))
  })

  it('reports no missing plugins when agent has all required', () => {
    const scenarioPlugins = ['delegate', 'browser']
    const agent = { plugins: ['delegate', 'browser', 'email', 'files'] }

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'agent')

    assert.deepEqual(result.missingPlugins, [])
    assert.deepEqual(result.effectivePlugins, ['delegate', 'browser', 'email', 'files'])
  })

  it('handles plugin aliases — web_search resolves to canonical web', () => {
    // 'web_search' is an alias for 'web'. When the scenario requires 'web_search',
    // canonicalization maps it to 'web'. If the agent has 'web', it should not
    // appear in missingPlugins because expandPluginIds expands 'web' to include
    // all aliases.
    const scenarioPlugins = ['web_search']
    const agent = { plugins: ['web'] }

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'agent')
    assert.deepEqual(result.missingPlugins, [])
  })

  it('handles alias in scenario mode — effectivePlugins preserves original strings', () => {
    const scenarioPlugins = ['web_search', 'claude_code']
    const agent = { plugins: [] }

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'scenario')

    // In scenario mode, effectivePlugins comes from normalizePluginList(requiredPlugins)
    // which preserves original strings
    assert.deepEqual(result.effectivePlugins, ['web_search', 'claude_code'])
    assert.deepEqual(result.missingPlugins, [])
  })

  it('empty agent plugins — all scenario plugins are missing', () => {
    const scenarioPlugins = ['delegate', 'browser', 'web']
    const agent = { plugins: [] }

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'agent')

    assert.deepEqual(result.effectivePlugins, [])
    assert.equal(result.missingPlugins.length, 3)
    assert.ok(result.missingPlugins.includes('delegate'))
    assert.ok(result.missingPlugins.includes('browser'))
    assert.ok(result.missingPlugins.includes('web'))
  })

  it('undefined agent plugins — all scenario plugins are missing', () => {
    const scenarioPlugins = ['delegate', 'browser']
    const agent: Record<string, unknown> = {}

    const result = resolveRegressionPlugins(scenarioPlugins, agent, 'agent')

    assert.deepEqual(result.effectivePlugins, [])
    assert.equal(result.missingPlugins.length, 2)
  })

  it('requiredPlugins are canonicalized in both modes', () => {
    const scenarioPlugins = ['claude_code', 'web_fetch']

    const scenarioResult = resolveRegressionPlugins(scenarioPlugins, {}, 'scenario')
    const agentResult = resolveRegressionPlugins(scenarioPlugins, { plugins: [] }, 'agent')

    // 'claude_code' → canonical 'delegate', 'web_fetch' → canonical 'web'
    assert.deepEqual(scenarioResult.requiredPlugins, ['delegate', 'web'])
    assert.deepEqual(agentResult.requiredPlugins, ['delegate', 'web'])
  })
})

// ---------------------------------------------------------------------------
// resolveRegressionApprovalSettings
// ---------------------------------------------------------------------------

describe('resolveRegressionApprovalSettings', () => {
  it('manual mode enables approvals with no auto-approve categories', () => {
    const settings = resolveRegressionApprovalSettings('manual')
    assert.equal(settings.approvalsEnabled, true)
    assert.deepEqual(settings.approvalAutoApproveCategories, [])
  })

  it('auto mode enables approvals with tool_access auto-approved', () => {
    const settings = resolveRegressionApprovalSettings('auto')
    assert.equal(settings.approvalsEnabled, true)
    assert.deepEqual(settings.approvalAutoApproveCategories, ['tool_access'])
  })

  it('off mode disables approvals entirely', () => {
    const settings = resolveRegressionApprovalSettings('off')
    assert.equal(settings.approvalsEnabled, false)
    assert.deepEqual(settings.approvalAutoApproveCategories, [])
  })
})

// ---------------------------------------------------------------------------
// AGENT_REGRESSION_SCENARIOS registry
// ---------------------------------------------------------------------------

describe('AGENT_REGRESSION_SCENARIOS registry', () => {
  it('contains the expected scenario IDs in order', () => {
    const ids = AGENT_REGRESSION_SCENARIOS.map((s) => s.id)
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

  it('every scenario has all required fields', () => {
    for (const scenario of AGENT_REGRESSION_SCENARIOS) {
      assert.ok(typeof scenario.id === 'string' && scenario.id.length > 0,
        `scenario missing non-empty id`)
      assert.ok(typeof scenario.name === 'string' && scenario.name.length > 0,
        `scenario ${scenario.id} missing non-empty name`)
      assert.ok(Array.isArray(scenario.plugins),
        `scenario ${scenario.id} missing plugins array`)
      assert.ok(typeof scenario.run === 'function',
        `scenario ${scenario.id} missing run function`)
    }
  })

  it('default suite ids exclude exploratory regressions unless explicitly requested', () => {
    assert.ok(!DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('blackboard-orchestrator-fit'))
    assert.ok(DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('approval-resume'))
    assert.ok(DEFAULT_AGENT_REGRESSION_SCENARIO_IDS.includes('knowledge-first-file'))
  })

  it('no duplicate scenario IDs', () => {
    const ids = AGENT_REGRESSION_SCENARIOS.map((s) => s.id)
    const unique = new Set(ids)
    assert.equal(unique.size, ids.length, 'duplicate scenario IDs detected')
  })

  it('every scenario declares at least an empty plugins array', () => {
    for (const scenario of AGENT_REGRESSION_SCENARIOS) {
      assert.ok(Array.isArray(scenario.plugins),
        `scenario ${scenario.id}: plugins should be an array`)
      // Each plugin entry should be a non-empty string
      for (const plugin of scenario.plugins) {
        assert.ok(typeof plugin === 'string' && plugin.trim().length > 0,
          `scenario ${scenario.id}: plugin entries must be non-empty strings`)
      }
    }
  })
})
