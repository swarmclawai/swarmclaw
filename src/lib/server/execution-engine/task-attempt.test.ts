import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BoardTask, KnowledgeRetrievalTrace } from '@/types'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'
import {
  buildTaskAttemptPrompt,
  buildTaskKnowledgeQuery,
} from '@/lib/server/execution-engine/task-attempt'

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'task-1',
    title: 'Example Task',
    description: 'Do the work',
    status: 'backlog',
    agentId: 'agent-1',
    sessionId: null,
    result: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

describe('buildTaskAttemptPrompt', () => {
  it('includes hydrated upstream results in the actual worker prompt', () => {
    const task = makeTask({
      description: 'Review the worker outputs.',
      upstreamResults: [{
        taskId: 'worker-1',
        taskTitle: 'Worker output',
        agentId: 'agent-1',
        resultPreview: 'WORKER_OK\nUseful findings.',
      }],
    })

    const prompt = buildTaskAttemptPrompt(task)

    assert.match(prompt, /Review the worker outputs\./)
    assert.match(prompt, /## Context from upstream tasks/)
    assert.match(prompt, /### Worker output/)
    assert.match(prompt, /WORKER_OK/)
    assert.match(prompt, /Completion requirements:/)
  })

  it('does not add an upstream context section when no upstream results are present', () => {
    const task = makeTask({ description: 'Standalone task.' })

    const prompt = buildTaskAttemptPrompt(task)

    assert.match(prompt, /Standalone task\./)
    assert.doesNotMatch(prompt, /Context from upstream tasks/)
  })

  it('injects source grounding when task-specific Knowledge retrieval has hits', () => {
    const task = makeTask({
      title: 'Knowledge smoke',
      description: 'Check SwarmClaw operator docs.',
    })
    const trace: KnowledgeRetrievalTrace = {
      query: 'Knowledge smoke\n\nCheck SwarmClaw operator docs.',
      scope: 'source_knowledge',
      retrievedAt: 123,
      selectorStatus: 'not_run',
      hits: [{
        sourceId: 'source-1',
        sourceTitle: 'SwarmClaw GUI Operator Manual',
        sourceKind: 'file',
        chunkId: 'chunk-1',
        chunkIndex: 0,
        chunkCount: 2,
        charStart: 0,
        charEnd: 120,
        sectionLabel: 'Agent Quickstart',
        snippet: 'Check memory, handoff, health, and local-only binding before operating.',
        score: 0.98,
      }],
    }

    const prompt = buildTaskAttemptPrompt(task, { knowledgeTrace: trace })

    assert.match(prompt, /## Source Grounding/)
    assert.match(prompt, /Source-backed Knowledge retrieved for this task:/)
    assert.match(prompt, /SwarmClaw GUI Operator Manual/)
    assert.match(prompt, /Check memory, handoff, health, and local-only binding/)
    assert.match(prompt, /Completion requirements:/)
  })

  it('builds the task Knowledge query from task title and description only', () => {
    const task = makeTask({
      title: 'Operator smoke',
      description: 'Use the sanitized operator docs.',
      cwd: '/do/not/include/path-values',
    })

    const query = buildTaskKnowledgeQuery(task)

    assert.equal(query, 'Operator smoke\n\nUse the sanitized operator docs.')
    assert.doesNotMatch(query, /do\/not\/include/)
  })

  it('keeps long task Knowledge queries searchable and source-focused', () => {
    const filler = Array.from({ length: 80 }, (_, i) => `implementation detail ${i}`).join(' ')
    const task = makeTask({
      title: 'Operator drill F043 source grounding smoke',
      description: [
        filler,
        'Source titles: SwarmClaw GUI Operator Manual; SwarmClaw Next-Agent Quickstart; SwarmClaw Dynamic Workflow Operator Recipe; SwarmClaw Operator Failure Catalog.',
      ].join('\n'),
    })

    const query = buildTaskKnowledgeQuery(task)

    assert.equal(query.length <= 1000, true)
    assert.match(query, /SwarmClaw GUI Operator Manual/)
    assert.match(query, /SwarmClaw Operator Failure Catalog/)
  })

  it('retrieves source Knowledge for task prompts without requiring agent proactive memory', () => {
    const output = runWithTempDataDir<{
      hitCount: number
      firstSourceTitle: string | null
    }>(`
      const knowledgeMod = await import('@/lib/server/knowledge-sources')
      const taskAttemptMod = await import('@/lib/server/execution-engine/task-attempt')
      const knowledge = knowledgeMod.default || knowledgeMod
      const taskAttempt = taskAttemptMod.default || taskAttemptMod

      await knowledge.createKnowledgeSource({
        kind: 'manual',
        title: 'SwarmClaw Operator Quickstart',
        content: 'Direct assignment tasks should cite source-backed Knowledge. Confirm source-backed Knowledge appears for SwarmClaw operator tasks.',
        tags: ['swarmclaw'],
      })

      const trace = await taskAttempt.buildTaskKnowledgeRetrievalTrace({
        id: 'task-knowledge',
        title: 'Direct assignment Knowledge smoke',
        description: 'Confirm source-backed Knowledge appears for SwarmClaw operator tasks.',
        status: 'queued',
        agentId: 'builder-agent-without-proactive-memory',
        sessionId: null,
        result: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
      })

      console.log(JSON.stringify({
        hitCount: trace?.hits?.length || 0,
        firstSourceTitle: trace?.hits?.[0]?.sourceTitle || null,
      }))
    `, { prefix: 'swarmclaw-task-grounding-' })

    assert.equal(output.hitCount >= 1, true)
    assert.equal(output.firstSourceTitle, 'SwarmClaw Operator Quickstart')
  })

  it('falls back to Knowledge memory chunks when source records do not resolve', () => {
    const output = runWithTempDataDir<{
      hitCount: number
      firstSourceTitle: string | null
    }>(`
      const memoryMod = await import('@/lib/server/memory/memory-db')
      const taskAttemptMod = await import('@/lib/server/execution-engine/task-attempt')
      const memoryDb = memoryMod.default || memoryMod
      const taskAttempt = taskAttemptMod.default || taskAttemptMod

      memoryDb.getMemoryDb().add({
        agentId: null,
        sessionId: null,
        category: 'knowledge',
        title: 'SwarmClaw Operator Failure Catalog',
        content: 'F043 says task source grounding must inject source-backed Knowledge into direct-assignment task prompts.',
        metadata: {
          sourceId: 'missing-source-record',
          sourceTitle: 'SwarmClaw Operator Failure Catalog',
          sourceKind: 'manual',
          scope: 'global',
          agentIds: [],
          chunkIndex: 0,
          chunkCount: 1,
          charStart: 0,
          charEnd: 105,
        },
      })

      const trace = await taskAttempt.buildTaskKnowledgeRetrievalTrace({
        id: 'task-knowledge-fallback',
        title: 'F043 strict source grounding smoke',
        description: 'Retrieval topic: task-source grounding failure catalog entry.',
        status: 'queued',
        agentId: 'builder-agent-without-proactive-memory',
        sessionId: null,
        result: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
      })

      console.log(JSON.stringify({
        hitCount: trace?.hits?.length || 0,
        firstSourceTitle: trace?.hits?.[0]?.sourceTitle || null,
      }))
    `, { prefix: 'swarmclaw-task-grounding-fallback-' })

    assert.equal(output.hitCount >= 1, true)
    assert.equal(output.firstSourceTitle, 'SwarmClaw Operator Failure Catalog')
  })
})
