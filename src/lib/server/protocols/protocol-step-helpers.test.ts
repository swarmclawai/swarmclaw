import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

let mod: typeof import('@/lib/server/protocols/protocol-step-helpers')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/protocols/protocol-step-helpers')
})

after(() => {
  delete process.env.SWARMCLAW_BUILD_MODE
})

describe('protocol-step-helpers', () => {
  // ---- phaseFromStep ----
  describe('phaseFromStep', () => {
    it('converts discussion step to phase', () => {
      const step = {
        id: 'step-1',
        kind: 'present',
        label: 'Presentation',
        instructions: 'Present findings',
        turnLimit: 3,
        completionCriteria: 'All presented',
      } as never
      const phase = mod.phaseFromStep(step)
      assert.equal(phase.id, 'step-1')
      assert.equal(phase.kind, 'present')
      assert.equal(phase.label, 'Presentation')
      assert.equal(phase.instructions, 'Present findings')
      assert.equal(phase.turnLimit, 3)
      assert.equal(phase.completionCriteria, 'All presented')
    })

    it('throws on non-discussion step type', () => {
      const step = {
        id: 'step-1',
        kind: 'parallel',
        label: 'Parallel Step',
      } as never
      assert.throws(() => mod.phaseFromStep(step), {
        message: /not a discussion phase/,
      })
    })

    it('converts all valid discussion step kinds', () => {
      const kinds = [
        'present', 'collect_independent_inputs', 'round_robin',
        'compare', 'decide', 'summarize', 'emit_tasks', 'wait',
        'dispatch_task', 'dispatch_delegation', 'a2a_delegate',
      ]
      for (const kind of kinds) {
        const step = { id: `step-${kind}`, kind, label: kind } as never
        const phase = mod.phaseFromStep(step)
        assert.equal(phase.kind, kind)
      }
    })
  })

  // ---- buildParallelBranchState ----
  describe('buildParallelBranchState', () => {
    it('creates state from run + fallback', () => {
      const run = {
        status: 'completed',
        participantAgentIds: ['a1', 'a2'],
        summary: 'Done.',
        lastError: null,
        updatedAt: 1000,
      } as never
      const fallback = {
        branchId: 'b1',
        label: 'Branch 1',
        runId: 'run-1',
      }
      const state = mod.buildParallelBranchState(run, fallback)
      assert.equal(state.branchId, 'b1')
      assert.equal(state.label, 'Branch 1')
      assert.equal(state.runId, 'run-1')
      assert.equal(state.status, 'completed')
      assert.deepEqual(state.participantAgentIds, ['a1', 'a2'])
      assert.equal(state.summary, 'Done.')
    })

    it('uses fallback values when run is null', () => {
      const fallback = {
        branchId: 'b2',
        label: 'Branch 2',
        runId: 'run-2',
        status: 'draft' as const,
        participantAgentIds: ['a3'],
      }
      const state = mod.buildParallelBranchState(null, fallback)
      assert.equal(state.status, 'draft')
      assert.deepEqual(state.participantAgentIds, ['a3'])
      assert.equal(state.summary, null)
    })
  })

  // ---- buildParallelStepState ----
  describe('buildParallelStepState', () => {
    it('creates state for branches', () => {
      const branches = [
        { branchId: 'b1', label: 'B1', runId: 'r1', status: 'completed' as const, participantAgentIds: [], summary: null, lastError: null, updatedAt: 1 },
        { branchId: 'b2', label: 'B2', runId: 'r2', status: 'running' as const, participantAgentIds: [], summary: null, lastError: null, updatedAt: 2 },
      ]
      const state = mod.buildParallelStepState('step-1', branches)
      assert.equal(state.stepId, 'step-1')
      assert.deepEqual(state.branchRunIds, ['r1', 'r2'])
      assert.deepEqual(state.waitingOnBranchIds, ['b2'])
      assert.equal(state.joinReady, false)
    })

    it('joinReady when all branches terminal', () => {
      const branches = [
        { branchId: 'b1', label: 'B1', runId: 'r1', status: 'completed' as const, participantAgentIds: [], summary: null, lastError: null, updatedAt: 1 },
        { branchId: 'b2', label: 'B2', runId: 'r2', status: 'failed' as const, participantAgentIds: [], summary: null, lastError: null, updatedAt: 2 },
      ]
      const state = mod.buildParallelStepState('step-1', branches)
      assert.deepEqual(state.waitingOnBranchIds, [])
      assert.equal(state.joinReady, true)
    })

    it('handles empty branches', () => {
      const state = mod.buildParallelStepState('step-1', [])
      assert.deepEqual(state.branchRunIds, [])
      assert.deepEqual(state.waitingOnBranchIds, [])
      assert.equal(state.joinReady, false)
    })
  })

  // ---- buildParallelBranchRunTitle ----
  describe('buildParallelBranchRunTitle', () => {
    it('joins run title, step label, and branch label', () => {
      const run = { title: 'My Protocol' } as never
      const step = { label: 'Parallel Step' } as never
      const branch = { label: 'Branch A' } as never
      const title = mod.buildParallelBranchRunTitle(run, step, branch)
      assert.ok(title.includes('My Protocol'))
      assert.ok(title.includes('Parallel Step'))
      assert.ok(title.includes('Branch A'))
    })
  })
})
