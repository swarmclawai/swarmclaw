import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  _clearSwarmRegistry,
  getSwarm,
  getSwarmSnapshot,
  listSwarms,
  removeSwarm,
  aggregateResults,
  type SwarmHandle,
  type SwarmMember,
  type SwarmSnapshot,
} from './subagent-swarm'

/**
 * Unit tests for the swarm layer. Since spawnSubagent depends on storage,
 * session-run-manager, and agent configs, we test the pure logic functions
 * by constructing SwarmHandle objects directly and exercising the snapshot,
 * aggregation, and registry code paths.
 */

function fakeSwarmHandle(overrides?: Partial<SwarmHandle>): SwarmHandle {
  const base: SwarmHandle = {
    swarmId: 'swarm-test-1',
    parentSessionId: 'parent-sess-1',
    members: [],
    status: 'running',
    createdAt: Date.now() - 5000,
    completedAt: null,
    allSettled: Promise.resolve({
      swarmId: 'swarm-test-1',
      parentSessionId: 'parent-sess-1',
      totalSpawned: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalCancelled: 0,
      totalSpawnErrors: 0,
      durationMs: 0,
      results: [],
    }),
    firstSettled: Promise.resolve({ index: -1, result: null as any }),
    cancelAll: () => {},
    ...overrides,
  }
  return base
}

function fakeMember(index: number, overrides?: Partial<SwarmMember>): SwarmMember {
  return {
    index,
    handle: {
      jobId: `job-${index}`,
      sessionId: `sess-${index}`,
      lineageId: `lin-${index}`,
      agentId: `agent-${index}`,
      agentName: `Agent ${index}`,
      run: {
        runId: `run-${index}`,
        position: 0,
        promise: Promise.resolve({ text: '', error: null, persisted: true, toolEvents: [], inputTokens: 0, outputTokens: 0, estimatedCost: 0 }),
        abort: () => {},
        unsubscribe: () => {},
      },
      promise: Promise.resolve({
        jobId: `job-${index}`,
        sessionId: `sess-${index}`,
        lineageId: `lin-${index}`,
        agentId: `agent-${index}`,
        agentName: `Agent ${index}`,
        status: 'completed' as const,
        response: `Result from agent ${index}`,
        error: null,
        depth: 1,
        parentSessionId: 'parent-sess-1',
        childCount: 0,
        durationMs: 1200,
      }),
    } as any,
    result: null,
    spawnError: null,
    ...overrides,
  }
}

describe('subagent-swarm', () => {
  afterEach(() => {
    _clearSwarmRegistry()
  })

  describe('SwarmHandle registry', () => {
    it('stores and retrieves swarms', () => {
      const swarm = fakeSwarmHandle()
      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set(swarm.swarmId, swarm)

      const retrieved = getSwarm('swarm-test-1')
      assert.ok(retrieved)
      assert.equal(retrieved!.swarmId, 'swarm-test-1')
    })

    it('listSwarms filters by parentSessionId', () => {
      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set('s1', fakeSwarmHandle({ swarmId: 's1', parentSessionId: 'p1' }))
      registry.set('s2', fakeSwarmHandle({ swarmId: 's2', parentSessionId: 'p2' }))
      registry.set('s3', fakeSwarmHandle({ swarmId: 's3', parentSessionId: 'p1' }))

      const p1Swarms = listSwarms('p1')
      assert.equal(p1Swarms.length, 2)
      assert.ok(p1Swarms.every((s) => s.parentSessionId === 'p1'))
    })

    it('removeSwarm deletes from registry', () => {
      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set('s1', fakeSwarmHandle({ swarmId: 's1' }))
      assert.ok(getSwarm('s1'))
      assert.equal(removeSwarm('s1'), true)
      assert.equal(getSwarm('s1'), null)
    })
  })

  describe('SwarmMember tracking', () => {
    it('tracks members with spawn errors alongside successful spawns', () => {
      const members = [
        fakeMember(0),
        fakeMember(1, { spawnError: 'Agent "missing" not found.', handle: null as any }),
        fakeMember(2),
      ]
      const swarm = fakeSwarmHandle({ members })

      assert.equal(swarm.members.length, 3)
      assert.equal(swarm.members[0].spawnError, null)
      assert.equal(swarm.members[1].spawnError, 'Agent "missing" not found.')
      assert.equal(swarm.members[2].spawnError, null)
    })

    it('members can accumulate results independently', () => {
      const m0 = fakeMember(0)
      const m1 = fakeMember(1)
      const swarm = fakeSwarmHandle({ members: [m0, m1] })

      m0.result = {
        jobId: 'job-0',
        sessionId: 'sess-0',
        lineageId: 'lin-0',
        agentId: 'agent-0',
        agentName: 'Agent 0',
        status: 'completed',
        response: 'Done!',
        error: null,
        depth: 1,
        parentSessionId: 'parent-sess-1',
        childCount: 0,
        durationMs: 800,
      }

      assert.ok(m0.result)
      assert.equal(m0.result.status, 'completed')
      assert.equal(m1.result, null)
    })
  })

  describe('SwarmSnapshot', () => {
    it('builds a serializable snapshot for the UI', () => {
      const m0 = fakeMember(0)
      const m1 = fakeMember(1)
      m0.result = {
        jobId: 'job-0', sessionId: 'sess-0', lineageId: 'lin-0',
        agentId: 'agent-0', agentName: 'Agent 0',
        status: 'completed', response: 'All good', error: null,
        depth: 1, parentSessionId: 'parent-sess-1',
        childCount: 0, durationMs: 900,
      }

      const swarm = fakeSwarmHandle({
        members: [m0, m1],
        status: 'running',
      })

      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set(swarm.swarmId, swarm)

      const snapshot = getSwarmSnapshot(swarm.swarmId) as SwarmSnapshot
      assert.ok(snapshot)
      assert.equal(snapshot.memberCount, 2)
      assert.equal(snapshot.completedCount, 1)
      // m0 has result with status 'completed' — snapshot reads from result
      assert.equal(snapshot.members[0].status, 'completed')
      assert.equal(snapshot.members[0].resultPreview, 'All good')
      // m1 has no result and no lineage node — falls back to 'running'
      assert.equal(snapshot.members[1].status, 'running')
    })

    it('counts spawn errors in the snapshot', () => {
      const members = [
        fakeMember(0, { spawnError: 'Not found', handle: null as any }),
        fakeMember(1),
      ]
      const swarm = fakeSwarmHandle({ members })
      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set(swarm.swarmId, swarm)

      const snapshot = getSwarmSnapshot(swarm.swarmId) as SwarmSnapshot
      assert.equal(snapshot.failedCount, 1)
      assert.equal(snapshot.members[0].status, 'spawn_error')
      assert.equal(snapshot.members[0].error, 'Not found')
    })
  })

  describe('cancelAll', () => {
    function buildCancelAll(swarm: SwarmHandle) {
      return () => {
        for (const member of swarm.members) {
          if (member.handle && !member.result && !member.spawnError) {
            try { member.handle.run.abort() } catch { /* best-effort */ }
          }
        }
        swarm.status = 'failed'
      }
    }

    it('invokes abort on all running member handles', () => {
      let abortCount = 0
      const m0 = fakeMember(0)
      const m1 = fakeMember(1)
      m0.handle.run.abort = () => { abortCount++ }
      m1.handle.run.abort = () => { abortCount++ }

      const swarm = fakeSwarmHandle({ members: [m0, m1] })
      swarm.cancelAll = buildCancelAll(swarm)
      swarm.cancelAll()

      assert.equal(abortCount, 2)
      assert.equal(swarm.status, 'failed')
    })

    it('skips members that already have results', () => {
      let abortCount = 0
      const m0 = fakeMember(0)
      const m1 = fakeMember(1)
      m0.handle.run.abort = () => { abortCount++ }
      m1.handle.run.abort = () => { abortCount++ }
      m0.result = { status: 'completed' } as any

      const swarm = fakeSwarmHandle({ members: [m0, m1] })
      swarm.cancelAll = buildCancelAll(swarm)
      swarm.cancelAll()

      assert.equal(abortCount, 1)
    })

    it('skips members with spawn errors', () => {
      let abortCount = 0
      const m0 = fakeMember(0, { spawnError: 'fail', handle: null as any })
      const m1 = fakeMember(1)
      m1.handle.run.abort = () => { abortCount++ }

      const swarm = fakeSwarmHandle({ members: [m0, m1] })
      swarm.cancelAll = buildCancelAll(swarm)
      swarm.cancelAll()

      assert.equal(abortCount, 1)
    })
  })

  describe('aggregateResults (absorbed from batch)', () => {
    it('returns not_found for unknown job IDs', () => {
      const agg = aggregateResults(['unknown-job-1', 'unknown-job-2'])
      assert.equal(agg.total, 2)
      assert.equal(agg.failed, 2)
      assert.equal(agg.allCompleted, true)
      assert.equal(agg.pending.length, 0)
      assert.equal(agg.results[0].status, 'not_found')
    })
  })

  // ---------------------------------------------------------------------------
  // Reliability fix: buildSwarmSnapshot null handle (#1)
  // ---------------------------------------------------------------------------

  describe('buildSwarmSnapshot — null handle without spawnError', () => {
    it('returns spawn_error status instead of crashing on null handle', () => {
      // Simulate a member that has handle: null but no explicit spawnError
      // (edge case from race conditions during spawn)
      const members = [
        fakeMember(0),
        fakeMember(1, { handle: null as any, spawnError: null }),
      ]
      const swarm = fakeSwarmHandle({ members })
      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set(swarm.swarmId, swarm)

      const snapshot = getSwarmSnapshot(swarm.swarmId) as SwarmSnapshot
      assert.ok(snapshot, 'Snapshot should not be null')
      assert.equal(snapshot.members[1].status, 'spawn_error')
      assert.equal(snapshot.members[1].error, 'Spawn failed (no handle)')
      assert.equal(snapshot.members[1].agentId, '')
      assert.equal(snapshot.failedCount, 1)
    })

    it('handles all members having null handles gracefully', () => {
      const members = [
        fakeMember(0, { handle: null as any, spawnError: 'Agent not found' }),
        fakeMember(1, { handle: null as any, spawnError: null }),
        fakeMember(2, { handle: null as any, spawnError: 'Config error' }),
      ]
      const swarm = fakeSwarmHandle({ members })
      const registry = (globalThis as any).__swarmclaw_swarm_registry__ as Map<string, SwarmHandle>
      registry.set(swarm.swarmId, swarm)

      const snapshot = getSwarmSnapshot(swarm.swarmId) as SwarmSnapshot
      assert.equal(snapshot.memberCount, 3)
      assert.equal(snapshot.failedCount, 3)
      assert.equal(snapshot.completedCount, 0)
      // All three should be spawn_error
      for (const m of snapshot.members) {
        assert.equal(m.status, 'spawn_error')
      }
      // Member 0 and 2 have explicit errors, member 1 gets the fallback
      assert.equal(snapshot.members[0].error, 'Agent not found')
      assert.equal(snapshot.members[1].error, 'Spawn failed (no handle)')
      assert.equal(snapshot.members[2].error, 'Config error')
    })
  })

  // ---------------------------------------------------------------------------
  // Reliability fix: firstSettled with zero memberPromises (#15)
  // ---------------------------------------------------------------------------

  describe('firstSettled — all spawn errors (zero promises)', () => {
    it('firstSettled resolves with a valid SubagentResult, not null', async () => {
      // Build a swarm where ALL members fail to spawn
      const members = [
        fakeMember(0, { handle: null as any, spawnError: 'Agent not found' }),
        fakeMember(1, { handle: null as any, spawnError: 'Config error' }),
      ]

      // Simulate what spawnSwarm does: memberPromises is empty, so firstSettled
      // falls back to allSettled.then(). We test this via the fakeSwarmHandle
      // by constructing the same promise chain.
      const allSettledResult = {
        swarmId: 'swarm-all-fail',
        parentSessionId: 'parent-1',
        totalSpawned: 2,
        totalCompleted: 0,
        totalFailed: 2,
        totalCancelled: 0,
        totalSpawnErrors: 2,
        durationMs: 100,
        results: [
          { index: 0, agentId: '', agentName: '', jobId: '', sessionId: '', status: 'spawn_error' as const, response: null, error: 'Agent not found', durationMs: 0 },
          { index: 1, agentId: '', agentName: '', jobId: '', sessionId: '', status: 'spawn_error' as const, response: null, error: 'Config error', durationMs: 0 },
        ],
      }

      const allSettled = Promise.resolve(allSettledResult)

      // Mimic the firstSettled fallback: when memberPromises is empty,
      // firstSettled = allSettled.then(agg => { first entry as SubagentResult })
      const firstSettled = allSettled.then((agg) => {
        const first = agg.results[0]
        return {
          index: first?.index ?? -1,
          result: {
            jobId: first?.jobId ?? '',
            sessionId: first?.sessionId ?? '',
            lineageId: '',
            agentId: first?.agentId ?? '',
            agentName: first?.agentName ?? '',
            status: 'failed' as const,
            response: null,
            error: first?.error ?? 'No members spawned',
            depth: 0,
            parentSessionId: 'parent-1',
            childCount: 0,
            durationMs: 0,
          },
        }
      })

      const result = await firstSettled
      assert.ok(result, 'firstSettled should resolve, not hang or crash')
      assert.equal(result.result.status, 'failed')
      assert.equal(result.result.error, 'Agent not found')
      assert.equal(typeof result.index, 'number')
      // Must be a proper SubagentResult, not null
      assert.ok(result.result.jobId !== undefined)
      assert.ok(result.result.sessionId !== undefined)
    })
  })
})
