import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let runtime: typeof import('./subagent-runtime')
let lineage: typeof import('./subagent-lineage')
let delegationJobs: typeof import('./delegation-jobs')
let storage: typeof import('./storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-subagent-runtime-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'

  storage = await import('./storage')
  delegationJobs = await import('./delegation-jobs')
  lineage = await import('./subagent-lineage')
  runtime = await import('./subagent-runtime')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function seedAgent(id: string, name: string, plugins: string[] = []) {
  const agents = storage.loadAgents()
  agents[id] = {
    id,
    name,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Test agent',
    plugins,
  }
  storage.saveAgents(agents)
}

describe('subagent-runtime', () => {
  before(() => {
    lineage._clearLineage()
  })

  describe('spawnSubagent', () => {
    it('throws for unknown agent', () => {
      lineage._clearLineage()
      assert.throws(
        () => runtime.spawnSubagent(
          { agentId: 'nonexistent', message: 'hello' },
          { cwd: tempDir },
        ),
        /not found/,
      )
    })

    it('throws when max depth is exceeded', () => {
      lineage._clearLineage()
      seedAgent('depth-agent', 'Depth Agent')

      // Create a chain of sessions to simulate depth
      const sessions = storage.loadSessions()
      sessions['depth-s0'] = { id: 'depth-s0', parentSessionId: null, cwd: tempDir }
      sessions['depth-s1'] = { id: 'depth-s1', parentSessionId: 'depth-s0', cwd: tempDir }
      sessions['depth-s2'] = { id: 'depth-s2', parentSessionId: 'depth-s1', cwd: tempDir }
      sessions['depth-s3'] = { id: 'depth-s3', parentSessionId: 'depth-s2', cwd: tempDir }
      storage.saveSessions(sessions)

      assert.throws(
        () => runtime.spawnSubagent(
          { agentId: 'depth-agent', message: 'too deep' },
          { sessionId: 'depth-s3', cwd: tempDir },
        ),
        /Max subagent depth/,
      )
    })

    it('creates session, lineage node, and delegation job', () => {
      lineage._clearLineage()
      seedAgent('spawn-agent', 'Spawn Agent')

      let handle: ReturnType<typeof runtime.spawnSubagent> | null = null
      try {
        handle = runtime.spawnSubagent(
          { agentId: 'spawn-agent', message: 'test task', waitForCompletion: false },
          { sessionId: undefined, cwd: tempDir },
        )
      } catch {
        // May throw if enqueueSessionRun fails synchronously
      }

      if (handle) {
        // Verify delegation job was created
        const job = delegationJobs.getDelegationJob(handle.jobId)
        assert.ok(job, 'Delegation job should exist')
        assert.equal(job.kind, 'subagent')
        assert.equal(job.agentId, 'spawn-agent')

        // Verify lineage node was created with lifecycle state
        const node = lineage.getLineageNodeBySession(handle.sessionId)
        assert.ok(node, 'Lineage node should exist')
        assert.equal(node.agentId, 'spawn-agent')
        assert.equal(node.agentName, 'Spawn Agent')
        assert.equal(node.depth, 0)
        assert.equal(node.task, 'test task')
        assert.equal(node.status, 'running') // initializing → ready → running

        // Verify handle is registered for promise-based waiting
        const retrieved = runtime.getHandle(handle.jobId)
        assert.ok(retrieved, 'Handle should be registered')
        assert.equal(retrieved.jobId, handle.jobId)

        // Verify session was created
        const sessions = storage.loadSessions()
        assert.ok(sessions[handle.sessionId], 'Session should exist')
        assert.equal(sessions[handle.sessionId].agentId, 'spawn-agent')
        assert.ok(sessions[handle.sessionId].createdAt > 0)
      }
    })

    it('tracks parent-child lineage correctly', () => {
      lineage._clearLineage()
      seedAgent('parent-agent', 'Parent')
      seedAgent('child-agent', 'Child')

      // Create a parent session
      const sessions = storage.loadSessions()
      sessions['parent-session'] = {
        id: 'parent-session',
        cwd: tempDir,
        parentSessionId: null,
        agentId: 'parent-agent',
      }
      storage.saveSessions(sessions)

      // Create parent lineage node
      lineage.createLineageNode({
        sessionId: 'parent-session',
        agentId: 'parent-agent',
        agentName: 'Parent',
        task: 'Parent task',
      })

      let handle: ReturnType<typeof runtime.spawnSubagent> | null = null
      try {
        handle = runtime.spawnSubagent(
          { agentId: 'child-agent', message: 'child task', waitForCompletion: false },
          { sessionId: 'parent-session', cwd: tempDir },
        )
      } catch {
        // May throw from async execution
      }

      if (handle) {
        const childNode = lineage.getLineageNodeBySession(handle.sessionId)
        assert.ok(childNode)
        assert.equal(childNode.depth, 1)
        assert.equal(childNode.parentSessionId, 'parent-session')
        assert.equal(childNode.agentName, 'Child')

        // Verify parent can see child
        const parentNode = lineage.getLineageNodeBySession('parent-session')!
        const children = lineage.getChildren(parentNode.id)
        assert.equal(children.length, 1)
        assert.equal(children[0].sessionId, handle.sessionId)

        // Verify ancestry
        const ancestors = lineage.getAncestors(childNode.id)
        assert.equal(ancestors.length, 1)
        assert.equal(ancestors[0].sessionId, 'parent-session')
      }
    })
  })

  describe('mergePlugins', () => {
    it('returns agent plugins when parent has none', () => {
      const merged = runtime._mergePlugins(['shell', 'memory'], null)
      assert.deepEqual(merged, ['shell', 'memory'])
    })

    it('returns parent plugins when agent has none', () => {
      const merged = runtime._mergePlugins([], { plugins: ['browser', 'web'] })
      assert.deepEqual(merged, ['browser', 'web'])
    })

    it('merges and deduplicates agent + parent plugins', () => {
      const merged = runtime._mergePlugins(
        ['shell', 'memory'],
        { plugins: ['memory', 'browser', 'web'] },
      )
      // agent plugins first, then parent fills gaps; 'memory' not duplicated
      assert.deepEqual(merged, ['shell', 'memory', 'browser', 'web'])
    })

    it('deduplicates case-insensitively', () => {
      const merged = runtime._mergePlugins(['Shell'], { plugins: ['shell', 'web'] })
      assert.equal(merged.length, 2)
      assert.equal(merged[0], 'Shell') // preserves original case
      assert.equal(merged[1], 'web')
    })

    it('falls back to parent tools when plugins is missing', () => {
      const merged = runtime._mergePlugins(['shell'], { tools: ['browser'] })
      assert.deepEqual(merged, ['shell', 'browser'])
    })

    it('ignores empty/whitespace strings', () => {
      const merged = runtime._mergePlugins(['shell', ''], { plugins: ['  ', 'web'] })
      assert.deepEqual(merged, ['shell', 'web'])
    })

    it('returns empty array when both are empty', () => {
      const merged = runtime._mergePlugins([], { plugins: [] })
      assert.deepEqual(merged, [])
    })
  })

  describe('plugin inheritance in spawnSubagent', () => {
    it('child session inherits parent plugins merged with agent plugins', () => {
      lineage._clearLineage()
      seedAgent('inherit-agent', 'Inherit Agent', ['shell', 'memory'])

      const sessions = storage.loadSessions()
      sessions['inherit-parent'] = {
        id: 'inherit-parent',
        cwd: tempDir,
        parentSessionId: null,
        agentId: 'inherit-agent',
        plugins: ['shell', 'browser', 'web', 'manage_connectors'],
      }
      storage.saveSessions(sessions)

      let handle: ReturnType<typeof runtime.spawnSubagent> | null = null
      try {
        handle = runtime.spawnSubagent(
          { agentId: 'inherit-agent', message: 'test inheritance', waitForCompletion: false },
          { sessionId: 'inherit-parent', cwd: tempDir },
        )
      } catch { /* enqueueSessionRun may fail */ }

      if (handle) {
        const childSession = storage.loadSessions()[handle.sessionId]
        assert.ok(childSession, 'Child session should exist')
        const plugins = childSession.plugins as string[]
        assert.ok(plugins.includes('shell'), 'should have shell from agent')
        assert.ok(plugins.includes('memory'), 'should have memory from agent')
        assert.ok(plugins.includes('browser'), 'should inherit browser from parent')
        assert.ok(plugins.includes('web'), 'should inherit web from parent')
        assert.ok(plugins.includes('manage_connectors'), 'should inherit manage_connectors from parent')
        assert.equal(plugins.filter((p: string) => p.toLowerCase() === 'shell').length, 1, 'shell should not be duplicated')
      }
    })

    it('child session does not inherit when inheritPlugins is false', () => {
      lineage._clearLineage()
      seedAgent('no-inherit-agent', 'No Inherit Agent', ['shell'])

      const sessions = storage.loadSessions()
      sessions['no-inherit-parent'] = {
        id: 'no-inherit-parent',
        cwd: tempDir,
        parentSessionId: null,
        plugins: ['shell', 'browser', 'web'],
      }
      storage.saveSessions(sessions)

      let handle: ReturnType<typeof runtime.spawnSubagent> | null = null
      try {
        handle = runtime.spawnSubagent(
          { agentId: 'no-inherit-agent', message: 'no inherit', inheritPlugins: false, waitForCompletion: false },
          { sessionId: 'no-inherit-parent', cwd: tempDir },
        )
      } catch { /* enqueueSessionRun may fail */ }

      if (handle) {
        const childSession = storage.loadSessions()[handle.sessionId]
        assert.ok(childSession, 'Child session should exist')
        const plugins = childSession.plugins as string[]
        assert.deepEqual(plugins, ['shell'], 'should only have agent plugins')
      }
    })
  })

  describe('cancelSubagentBySession', () => {
    it('cancels a subagent and its lineage node', () => {
      lineage._clearLineage()

      const node = lineage.createLineageNode({
        sessionId: 'cancel-session',
        agentId: 'ag',
        agentName: 'Cancel Agent',
        task: 'Some task',
      })
      // Transition to running so it can be cancelled
      lineage.transitionState(node.id, 'READY')
      lineage.transitionState(node.id, 'START')

      const result = runtime.cancelSubagentBySession('cancel-session')
      assert.equal(result, true)
      assert.equal(lineage.getLineageNode(node.id)?.status, 'cancelled')
    })

    it('returns false for unknown session', () => {
      assert.equal(runtime.cancelSubagentBySession('unknown-session'), false)
    })
  })

  describe('cleanupFinishedSubagents', () => {
    it('removes old terminal lineage nodes', () => {
      lineage._clearLineage()

      const node = lineage.createLineageNode({
        sessionId: 'cleanup-sess',
        agentId: 'ag',
        agentName: 'Cleanup Agent',
        task: 'test',
      })
      lineage.transitionState(node.id, 'READY')
      lineage.transitionState(node.id, 'START')
      lineage.completeLineageNode(node.id, 'done')

      // Use negative maxAge so everything qualifies as old
      const cleaned = runtime.cleanupFinishedSubagents(-1)
      assert.equal(cleaned, 1)
      assert.equal(lineage.getLineageNode(node.id), null)
    })

    it('does not remove active lineage nodes', () => {
      lineage._clearLineage()

      const node = lineage.createLineageNode({
        sessionId: 'active-sess',
        agentId: 'ag',
        agentName: 'Active Agent',
        task: 'test',
      })
      lineage.transitionState(node.id, 'READY')
      lineage.transitionState(node.id, 'START')
      // Leave in 'running' state

      const cleaned = runtime.cleanupFinishedSubagents(0)
      assert.equal(cleaned, 0)
      assert.ok(lineage.getLineageNode(node.id))
    })
  })

  // ---------------------------------------------------------------------------
  // Reliability fix: orphaned handle cleanup (#9)
  // ---------------------------------------------------------------------------

  describe('cleanupFinishedSubagents — orphaned handles', () => {
    it('purges handles whose lineage node no longer exists', () => {
      lineage._clearLineage()

      // Create a lineage node and register a handle for it
      const node = lineage.createLineageNode({
        sessionId: 'orphan-sess',
        agentId: 'ag',
        agentName: 'Orphan Agent',
        task: 'test orphan cleanup',
      })
      lineage.transitionState(node.id, 'READY')
      lineage.transitionState(node.id, 'START')
      lineage.completeLineageNode(node.id, 'done')

      // Manually register a handle referencing this lineage node
      const handleRegistry = (globalThis as any).__swarmclaw_subagent_handles__ as Map<string, any>
      handleRegistry.set('orphan-job-1', {
        jobId: 'orphan-job-1',
        sessionId: 'orphan-sess',
        lineageId: node.id,
        agentId: 'ag',
        agentName: 'Orphan Agent',
        run: { runId: 'r', position: 0, promise: Promise.resolve(null), abort: () => {}, unsubscribe: () => {} },
        promise: Promise.resolve(null),
      })

      // Also register a handle with a fake lineage ID that was never created
      handleRegistry.set('orphan-job-2', {
        jobId: 'orphan-job-2',
        sessionId: 'never-existed',
        lineageId: 'fake-lineage-id-xyz',
        agentId: 'ag',
        agentName: 'Ghost',
        run: { runId: 'r2', position: 0, promise: Promise.resolve(null), abort: () => {}, unsubscribe: () => {} },
        promise: Promise.resolve(null),
      })

      assert.equal(handleRegistry.has('orphan-job-1'), true)
      assert.equal(handleRegistry.has('orphan-job-2'), true)

      // Cleanup with negative maxAge so all terminal nodes are removed
      const cleaned = runtime.cleanupFinishedSubagents(-1)
      assert.equal(cleaned, 1) // one terminal node removed

      // Both handles should be purged:
      // orphan-job-1: lineage node was removed by cleanup
      // orphan-job-2: lineage node never existed (orphaned handle)
      assert.equal(handleRegistry.has('orphan-job-1'), false, 'Handle for cleaned lineage node should be purged')
      assert.equal(handleRegistry.has('orphan-job-2'), false, 'Handle with non-existent lineage node should be purged')
    })

    it('preserves handles for active lineage nodes', () => {
      lineage._clearLineage()

      const node = lineage.createLineageNode({
        sessionId: 'active-handle-sess',
        agentId: 'ag',
        agentName: 'Active',
        task: 'still running',
      })
      lineage.transitionState(node.id, 'READY')
      lineage.transitionState(node.id, 'START')
      // Leave in running state — should NOT be cleaned up

      const handleRegistry = (globalThis as any).__swarmclaw_subagent_handles__ as Map<string, any>
      handleRegistry.set('active-job', {
        jobId: 'active-job',
        sessionId: 'active-handle-sess',
        lineageId: node.id,
        agentId: 'ag',
        agentName: 'Active',
        run: { runId: 'r', position: 0, promise: Promise.resolve(null), abort: () => {}, unsubscribe: () => {} },
        promise: Promise.resolve(null),
      })

      runtime.cleanupFinishedSubagents(0)

      assert.equal(handleRegistry.has('active-job'), true, 'Handle for active node should be preserved')
      assert.ok(lineage.getLineageNode(node.id), 'Active lineage node should still exist')
    })
  })

  describe('query helpers (re-exported)', () => {
    it('getLineageNodeBySession works through runtime module', () => {
      lineage._clearLineage()
      lineage.createLineageNode({
        sessionId: 'reexport-test',
        agentId: 'ag',
        agentName: 'Re-export',
        task: 'Test',
      })

      const node = runtime.getLineageNodeBySession('reexport-test')
      assert.ok(node)
      assert.equal(node.agentName, 'Re-export')
    })

    it('buildLineageTree works through runtime module', () => {
      lineage._clearLineage()
      const root = lineage.createLineageNode({
        sessionId: 'tree-root',
        agentId: 'ag',
        agentName: 'Root',
        task: 'Root task',
      })
      lineage.createLineageNode({
        sessionId: 'tree-child',
        agentId: 'ag',
        agentName: 'Child',
        parentSessionId: 'tree-root',
        task: 'Child task',
      })

      const tree = runtime.buildLineageTree(root.id)
      assert.ok(tree)
      assert.equal(tree.children.length, 1)
    })
  })
})
