import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

let mod: typeof import('@/lib/server/protocols/protocol-normalization')

const savedBuildMode = process.env.SWARMCLAW_BUILD_MODE
before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/protocols/protocol-normalization')
})

after(() => {
  if (savedBuildMode === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = savedBuildMode
})

describe('protocol-normalization', () => {
  // ---- normalizeCondition ----
  describe('normalizeCondition', () => {
    it('null/undefined → null', () => {
      assert.equal(mod.normalizeCondition(null), null)
      assert.equal(mod.normalizeCondition(undefined), null)
    })

    it('summary_exists passes through', () => {
      const result = mod.normalizeCondition({ type: 'summary_exists' })
      assert.deepEqual(result, { type: 'summary_exists' })
    })

    it('artifact_exists with artifactKind', () => {
      const result = mod.normalizeCondition({ type: 'artifact_exists', artifactKind: 'summary' })
      assert.deepEqual(result, { type: 'artifact_exists', artifactKind: 'summary' })
    })

    it('artifact_exists without artifactKind', () => {
      const result = mod.normalizeCondition({ type: 'artifact_exists' } as never)
      assert.deepEqual(result, { type: 'artifact_exists', artifactKind: null })
    })

    it('artifact_count_at_least clamps count, defaults artifactKind', () => {
      const result = mod.normalizeCondition({ type: 'artifact_count_at_least', count: -5, artifactKind: undefined } as never)
      assert.equal(result!.type, 'artifact_count_at_least')
      assert.equal((result as { count: number }).count, 0)
      assert.equal((result as { artifactKind: string | null }).artifactKind, null)
    })

    it('created_task_count_at_least clamps count', () => {
      const result = mod.normalizeCondition({ type: 'created_task_count_at_least', count: 3.7 })
      assert.equal(result!.type, 'created_task_count_at_least')
      assert.equal((result as { count: number }).count, 3)
    })

    it('all/any recursively normalizes children', () => {
      const result = mod.normalizeCondition({
        type: 'all',
        conditions: [
          { type: 'summary_exists' },
          { type: 'artifact_exists', artifactKind: 'notes' },
        ],
      })
      assert.equal(result!.type, 'all')
      const conditions = (result as { conditions: unknown[] }).conditions
      assert.equal(conditions.length, 2)
    })

    it('unknown type returns null', () => {
      assert.equal(mod.normalizeCondition({ type: 'bogus' } as never), null)
    })
  })

  // ---- normalizeStep ----
  describe('normalizeStep', () => {
    it('applies defaults (id, label, null fields)', () => {
      const result = mod.normalizeStep({
        kind: 'present',
      } as never)
      assert.ok(result.id) // auto-generated
      assert.equal(result.kind, 'present')
      assert.equal(result.label, 'present') // falls back to kind
      assert.equal(result.instructions, null)
      assert.equal(result.turnLimit, null)
      assert.equal(result.completionCriteria, null)
      assert.equal(result.nextStepId, null)
      assert.deepEqual(result.branchCases, [])
      assert.equal(result.repeat, null)
      assert.equal(result.parallel, null)
      assert.equal(result.join, null)
    })

    it('preserves existing values', () => {
      const result = mod.normalizeStep({
        id: 'step-1',
        kind: 'decide',
        label: 'Decision Point',
        instructions: 'Choose wisely',
        turnLimit: 5,
        completionCriteria: 'All agree',
        nextStepId: 'step-2',
        branchCases: [],
        defaultNextStepId: null,
        repeat: null,
        parallel: null,
        join: null,
      })
      assert.equal(result.id, 'step-1')
      assert.equal(result.label, 'Decision Point')
      assert.equal(result.instructions, 'Choose wisely')
      assert.equal(result.turnLimit, 5)
      assert.equal(result.nextStepId, 'step-2')
    })
  })

  // ---- normalizeRepeatConfig ----
  describe('normalizeRepeatConfig', () => {
    it('null/undefined returns null', () => {
      assert.equal(mod.normalizeRepeatConfig(null), null)
      assert.equal(mod.normalizeRepeatConfig(undefined), null)
    })

    it('validates count and defaults condition', () => {
      const result = mod.normalizeRepeatConfig({
        bodyStepId: 'step-body',
        maxIterations: 3,
      } as never)
      assert.ok(result)
      assert.equal(result!.bodyStepId, 'step-body')
      assert.equal(result!.maxIterations, 3)
      assert.equal(result!.exitCondition, null)
      assert.equal(result!.onExhausted, 'fail')
    })
  })

  // ---- normalizeParallelConfig ----
  describe('normalizeParallelConfig', () => {
    it('null returns null', () => {
      assert.equal(mod.normalizeParallelConfig(null), null)
    })

    it('empty branches returns null', () => {
      assert.equal(mod.normalizeParallelConfig({ branches: [] }), null)
    })

    it('normalizes branch definitions', () => {
      const result = mod.normalizeParallelConfig({
        branches: [{
          id: 'b1',
          label: 'Branch 1',
          steps: [{ id: 's1', kind: 'present', label: 'Step 1' }],
          entryStepId: 's1',
        } as never],
      })
      assert.ok(result)
      assert.equal(result!.branches.length, 1)
      assert.equal(result!.branches[0].label, 'Branch 1')
    })
  })

  // ---- compilePhasesToSteps ----
  describe('compilePhasesToSteps', () => {
    it('links phases into sequential steps', () => {
      const result = mod.compilePhasesToSteps([
        { id: 'p1', kind: 'present', label: 'Phase 1' } as never,
        { id: 'p2', kind: 'decide', label: 'Phase 2' } as never,
        { id: 'p3', kind: 'summarize', label: 'Phase 3' } as never,
      ])
      assert.equal(result.steps.length, 3)
      assert.equal(result.entryStepId, 'p1')
      assert.equal(result.steps[0].nextStepId, 'p2')
      assert.equal(result.steps[1].nextStepId, 'p3')
      assert.equal(result.steps[2].nextStepId, null)
    })

    it('handles single phase', () => {
      const result = mod.compilePhasesToSteps([
        { id: 'only', kind: 'present', label: 'Only Phase' } as never,
      ])
      assert.equal(result.steps.length, 1)
      assert.equal(result.entryStepId, 'only')
      assert.equal(result.steps[0].nextStepId, null)
    })

    it('handles empty phases', () => {
      const result = mod.compilePhasesToSteps([])
      assert.equal(result.steps.length, 0)
      assert.equal(result.entryStepId, null)
    })
  })

  // ---- findCurrentStepId ----
  describe('findCurrentStepId', () => {
    const steps = [
      { id: 'step-a', kind: 'present', label: 'A' },
      { id: 'step-b', kind: 'decide', label: 'B' },
    ] as never[]

    it('returns preferred if it exists in steps', () => {
      assert.equal(mod.findCurrentStepId(steps, 'step-b', 'step-a'), 'step-b')
    })

    it('returns null when status is completed', () => {
      assert.equal(mod.findCurrentStepId(steps, null, 'step-a', 0, 'completed'), null)
    })

    it('returns null when status is cancelled', () => {
      assert.equal(mod.findCurrentStepId(steps, null, 'step-a', 0, 'cancelled'), null)
    })

    it('returns indexed step when no preferred', () => {
      assert.equal(mod.findCurrentStepId(steps, null, null, 1), 'step-b')
    })

    it('returns entryStepId as fallback', () => {
      assert.equal(mod.findCurrentStepId(steps, null, 'step-a', 0), 'step-a')
    })

    it('returns null when currentPhaseIndex >= steps.length', () => {
      assert.equal(mod.findCurrentStepId(steps, null, null, 5), null)
    })
  })

  // ---- normalizeProtocolSourceRef ----
  describe('normalizeProtocolSourceRef', () => {
    it('manual fallback when no source info', () => {
      const result = mod.normalizeProtocolSourceRef({})
      assert.deepEqual(result, { kind: 'manual' })
    })

    it('chatroom source from parentChatroomId', () => {
      const result = mod.normalizeProtocolSourceRef({ parentChatroomId: 'cr-1' } as never)
      assert.deepEqual(result, { kind: 'chatroom', chatroomId: 'cr-1' })
    })

    it('mission source from missionId', () => {
      const result = mod.normalizeProtocolSourceRef({ missionId: 'm-1' } as never)
      assert.deepEqual(result, { kind: 'mission', missionId: 'm-1' })
    })

    it('schedule source from scheduleId', () => {
      const result = mod.normalizeProtocolSourceRef({ scheduleId: 'sch-1' } as never)
      assert.deepEqual(result, { kind: 'schedule', scheduleId: 'sch-1' })
    })

    it('preserves protocol_run sourceRef', () => {
      const result = mod.normalizeProtocolSourceRef({
        sourceRef: { kind: 'protocol_run', runId: 'r-1', parentRunId: null, stepId: null, branchId: null },
      } as never)
      assert.equal(result.kind, 'protocol_run')
    })
  })

  // ---- normalizeSwarmConfig ----
  describe('normalizeSwarmConfig', () => {
    it('null returns null', () => {
      assert.equal(mod.normalizeSwarmConfig(null), null)
    })

    it('missing eligibleAgentIds returns null', () => {
      assert.equal(mod.normalizeSwarmConfig({ workItemsSource: { type: 'literal', items: [] } } as never), null)
    })

    it('defaults and agent validation', () => {
      const result = mod.normalizeSwarmConfig({
        eligibleAgentIds: ['a1', 'a2'],
        workItemsSource: { type: 'literal', items: ['item1'] },
      } as never)
      assert.ok(result)
      assert.equal(result!.claimLimitPerAgent, 1)
      assert.equal(result!.selectionMode, 'first_claim')
      assert.equal(result!.claimTimeoutSec, 300)
      assert.equal(result!.onUnclaimed, 'fail')
    })
  })

  // ---- normalizeForEachConfig ----
  describe('normalizeForEachConfig', () => {
    it('null returns null', () => {
      assert.equal(mod.normalizeForEachConfig(null), null)
    })

    it('valid config with defaults', () => {
      const result = mod.normalizeForEachConfig({
        itemsSource: { type: 'literal', items: ['a'] },
        itemAlias: 'item',
        branchTemplate: {
          steps: [{ id: 's1', kind: 'present', label: 'Step' }],
          entryStepId: 's1',
        },
      } as never)
      assert.ok(result)
      assert.equal(result!.joinMode, 'all')
      assert.equal(result!.maxItems, 50)
      assert.equal(result!.onEmpty, 'fail')
    })
  })

  // ---- normalizeSubflowConfig ----
  describe('normalizeSubflowConfig', () => {
    it('null returns null', () => {
      assert.equal(mod.normalizeSubflowConfig(null), null)
    })

    it('template reference and overrides', () => {
      const result = mod.normalizeSubflowConfig({
        templateId: 'tpl-1',
        participantAgentIds: ['a1'],
        onFailure: 'advance_with_warning',
      } as never)
      assert.ok(result)
      assert.equal(result!.templateId, 'tpl-1')
      assert.deepEqual(result!.participantAgentIds, ['a1'])
      assert.equal(result!.onFailure, 'advance_with_warning')
    })

    it('missing templateId returns null', () => {
      assert.equal(mod.normalizeSubflowConfig({ participantAgentIds: ['a1'] } as never), null)
    })
  })
})
