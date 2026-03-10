import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR } from '@langchain/langgraph-checkpoint'
import type { Checkpoint } from '@langchain/langgraph-checkpoint'
import { SqliteCheckpointSaver } from './langgraph-checkpoint'

function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date('2026-03-10T12:00:00.000Z').toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  }
}

describe('SqliteCheckpointSaver', () => {
  it('round-trips typed checkpoint values and metadata', async () => {
    const saver = new SqliteCheckpointSaver(':memory:')
    const checkpoint = makeCheckpoint('cp_0001')
    checkpoint.channel_values.flags = new Set(['a', 'b'])

    await saver.put(
      { configurable: { thread_id: 'thread_1', checkpoint_ns: 'chat:test' } },
      checkpoint,
      { topic: 'typed', labels: new Set(['alpha', 'beta']) },
      {},
    )

    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread_1', checkpoint_ns: 'chat:test' },
    })

    assert.ok(tuple)
    assert.deepEqual(Array.from(tuple.checkpoint.channel_values.flags as Set<string>), ['a', 'b'])
    assert.deepEqual(tuple.metadata.topic, 'typed')
    assert.deepEqual(Array.from(tuple.metadata.labels as Set<string>), ['alpha', 'beta'])
  })

  it('preserves normal writes and replaces special writes using LangGraph indices', async () => {
    const saver = new SqliteCheckpointSaver(':memory:')
    const config = await saver.put(
      { configurable: { thread_id: 'thread_1', checkpoint_ns: 'chat:test' } },
      makeCheckpoint('cp_0001'),
      { phase: 'writes' },
      {},
    )

    await saver.putWrites(config, [['result', 'first']], 'task_1')
    await saver.putWrites(config, [['result', 'second']], 'task_1')
    await saver.putWrites(config, [[ERROR, 'error-1']], 'task_1')
    await saver.putWrites(config, [[ERROR, 'error-2']], 'task_1')

    const tuple = await saver.getTuple(config)
    assert.ok(tuple)

    const normalWrite = tuple.pendingWrites.find((entry) => entry[1] === 'result')
    const specialWrite = tuple.pendingWrites.find((entry) => entry[1] === ERROR)

    assert.deepEqual(normalWrite, ['task_1', 'result', 'first'])
    assert.deepEqual(specialWrite, ['task_1', ERROR, 'error-2'])
  })
})
