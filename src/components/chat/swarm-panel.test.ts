import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSwarmOutput, parseSwarmStatusOutput } from './swarm-panel'

describe('parseSwarmOutput', () => {
  it('returns null for non-spawn_subagent tools', () => {
    assert.equal(parseSwarmOutput('execute_command', '{}'), null)
    assert.equal(parseSwarmOutput('delegate_to_agent', '{}'), null)
  })

  it('returns null for invalid JSON', () => {
    assert.equal(parseSwarmOutput('spawn_subagent', 'not json'), null)
  })

  it('returns null for unrecognized output shapes', () => {
    assert.equal(parseSwarmOutput('spawn_subagent', '{"foo":"bar"}'), null)
  })

  it('parses batch running output', () => {
    const output = JSON.stringify({
      action: 'batch',
      status: 'running',
      jobIds: ['job-1', 'job-2', 'job-3'],
      taskCount: 3,
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'running')
    assert.equal(result.agents.length, 3)
    assert.deepEqual(result.jobIds, ['job-1', 'job-2', 'job-3'])
    assert.equal(result.agents[0].status, 'running')
    assert.equal(result.agents[0].agentName, 'Agent 1')
  })

  it('parses batch completed output', () => {
    const output = JSON.stringify({
      action: 'batch',
      status: 'completed',
      jobIds: ['job-1', 'job-2'],
      completed: 1,
      failed: 1,
      cancelled: 0,
      timedOut: 0,
      totalDurationMs: 5000,
      results: [
        { jobId: 'job-1', agentName: 'Research Agent', status: 'completed', response: 'Found results' },
        { jobId: 'job-2', agentName: 'Code Agent', status: 'failed', error: 'Compilation error' },
      ],
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'partial') // has failures
    assert.equal(result.agents.length, 2)
    assert.equal(result.completed, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.totalDurationMs, 5000)

    assert.equal(result.agents[0].agentName, 'Research Agent')
    assert.equal(result.agents[0].status, 'completed')
    assert.equal(result.agents[0].response, 'Found results')

    assert.equal(result.agents[1].agentName, 'Code Agent')
    assert.equal(result.agents[1].status, 'failed')
    assert.equal(result.agents[1].error, 'Compilation error')
  })

  it('parses batch completed all-success output', () => {
    const output = JSON.stringify({
      action: 'batch',
      status: 'completed',
      jobIds: ['job-1'],
      completed: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
      totalDurationMs: 2000,
      results: [
        { jobId: 'job-1', agentName: 'Solo Agent', status: 'completed', response: 'Done' },
      ],
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.status, 'completed') // no failures
  })

  it('parses single spawn running output', () => {
    const output = JSON.stringify({
      jobId: 'job-abc',
      status: 'running',
      agentId: 'research-agent',
      agentName: 'Research Agent',
      sessionId: 'sess-123',
      lineageId: 'lin-456',
      lifecycleState: 'running',
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'single')
    assert.equal(result.status, 'running')
    assert.equal(result.agents.length, 1)
    assert.equal(result.agents[0].agentName, 'Research Agent')
    assert.equal(result.agents[0].status, 'running')
    assert.equal(result.agents[0].lineageId, 'lin-456')
  })

  it('parses single spawn completed output', () => {
    const output = JSON.stringify({
      jobId: 'job-xyz',
      status: 'completed',
      agentId: 'code-agent',
      agentName: 'Code Agent',
      sessionId: 'sess-789',
      lineageId: 'lin-012',
      response: 'All tests passing',
      depth: 1,
      childCount: 0,
      durationMs: 15000,
      stateHistory: [],
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'single')
    assert.equal(result.status, 'completed')
    assert.equal(result.agents[0].agentName, 'Code Agent')
    assert.equal(result.agents[0].response, 'All tests passing')
    assert.equal(result.agents[0].durationMs, 15000)
    assert.equal(result.completed, 1)
    assert.equal(result.totalDurationMs, 15000)
  })

  it('parses single spawn failed output', () => {
    const output = JSON.stringify({
      jobId: 'job-fail',
      status: 'failed',
      agentId: 'bad-agent',
      agentName: 'Bad Agent',
      sessionId: 'sess-bad',
      error: 'Connection timeout',
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'single')
    assert.equal(result.status, 'failed')
    assert.equal(result.agents[0].error, 'Connection timeout')
    assert.equal(result.failed, 1)
  })

  it('parses swarm completed output with snapshot', () => {
    const output = JSON.stringify({
      action: 'swarm',
      status: 'completed',
      swarmId: 'swarm-1',
      snapshot: {
        swarmId: 'swarm-1',
        parentSessionId: 'parent-1',
        status: 'completed',
        createdAt: 1000,
        completedAt: 5000,
        memberCount: 2,
        completedCount: 2,
        failedCount: 0,
        members: [
          { index: 0, agentId: 'a1', agentName: 'Agent A', jobId: 'j1', sessionId: 's1', task: 'Do X', status: 'completed', resultPreview: 'Done X', error: null, durationMs: 2000 },
          { index: 1, agentId: 'a2', agentName: 'Agent B', jobId: 'j2', sessionId: 's2', task: 'Do Y', status: 'completed', resultPreview: 'Done Y', error: null, durationMs: 3000 },
        ],
      },
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'completed')
    assert.equal(result.agents.length, 2)
    assert.equal(result.agents[0].agentName, 'Agent A')
    assert.equal(result.agents[0].response, 'Done X')
    assert.equal(result.agents[1].agentName, 'Agent B')
    assert.equal(result.completed, 2)
    assert.equal(result.failed, 0)
  })

  it('parses swarm running output without snapshot', () => {
    const output = JSON.stringify({
      action: 'swarm',
      status: 'running',
      swarmId: 'swarm-2',
      memberCount: 3,
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'running')
    assert.equal(result.agents.length, 3)
    assert.equal(result.agents[0].status, 'running')
  })

  it('parses swarm with spawn errors as failed', () => {
    const output = JSON.stringify({
      action: 'swarm',
      status: 'partial',
      swarmId: 'swarm-3',
      snapshot: {
        swarmId: 'swarm-3',
        status: 'partial',
        memberCount: 2,
        completedCount: 1,
        failedCount: 1,
        members: [
          { index: 0, agentId: 'a1', agentName: 'OK Agent', status: 'completed', resultPreview: 'Done', error: null, durationMs: 1000 },
          { index: 1, agentId: '', agentName: '', status: 'spawn_error', resultPreview: null, error: 'Agent not found', durationMs: 0 },
        ],
      },
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.status, 'partial')
    assert.equal(result.agents[1].status, 'failed') // spawn_error mapped to failed
    assert.equal(result.agents[1].error, 'Agent not found')
  })
})

describe('parseSwarmStatusOutput', () => {
  it('returns null for non-swarm output', () => {
    assert.equal(parseSwarmStatusOutput('spawn_subagent', JSON.stringify({ action: 'batch', results: [] })), null)
    assert.equal(parseSwarmStatusOutput('other_tool', '{}'), null)
    assert.equal(parseSwarmStatusOutput('spawn_subagent', 'invalid'), null)
  })

  it('returns null when no snapshot is present', () => {
    assert.equal(parseSwarmStatusOutput('spawn_subagent', JSON.stringify({ action: 'swarm', status: 'running' })), null)
  })

  it('parses swarm output into SwarmStatusData', () => {
    const output = JSON.stringify({
      action: 'swarm',
      swarmId: 'swarm-rich',
      snapshot: {
        swarmId: 'swarm-rich',
        parentSessionId: 'parent-1',
        status: 'completed',
        createdAt: 1000,
        completedAt: 5000,
        memberCount: 2,
        completedCount: 2,
        failedCount: 0,
        members: [
          { index: 0, agentId: 'researcher', agentName: 'Researcher', jobId: 'j1', sessionId: 's1', task: 'Research APIs', status: 'completed', resultPreview: 'Found 3 APIs', error: null, durationMs: 2500 },
          { index: 1, agentId: 'coder', agentName: 'Coder', jobId: 'j2', sessionId: 's2', task: 'Write code', status: 'completed', resultPreview: 'Module ready', error: null, durationMs: 4000 },
        ],
      },
    })

    const result = parseSwarmStatusOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.swarmId, 'swarm-rich')
    assert.equal(result.status, 'completed')
    assert.equal(result.memberCount, 2)
    assert.equal(result.completedCount, 2)
    assert.equal(result.members.length, 2)
    assert.equal(result.members[0].agentName, 'Researcher')
    assert.equal(result.members[0].task, 'Research APIs')
    assert.equal(result.members[1].resultPreview, 'Module ready')
    assert.equal(result.parentAgentName, 'Orchestrator')
  })
})
