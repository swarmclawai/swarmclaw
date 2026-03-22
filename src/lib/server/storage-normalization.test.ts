import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeStoredRecord } from '@/lib/server/storage-normalization'

const loadItem = () => null

describe('storage normalization for runtime execution records', () => {
  it('backfills execution metadata on legacy runtime runs', () => {
    const { value, changed } = normalizeStoredRecord('runtime_runs', {
      id: 'run_1',
      sessionId: 'sess_1',
      source: 'task',
      internal: false,
      mode: 'followup',
      status: 'queued',
      messagePreview: 'Build the feature',
      queuedAt: 123,
    }, loadItem)

    const record = value as Record<string, unknown>
    assert.equal(changed, true)
    assert.equal(record.kind, 'session_turn')
    assert.equal(record.ownerType, 'session')
    assert.equal(record.ownerId, 'sess_1')
    assert.equal(record.parentExecutionId, null)
    assert.equal(record.recoveryPolicy, 'restart_recoverable')
  })

  it('backfills execution metadata on legacy runtime run events', () => {
    const { value, changed } = normalizeStoredRecord('runtime_run_events', {
      id: 'evt_1',
      runId: 'run_1',
      sessionId: 'sess_1',
      timestamp: 123,
      phase: 'status',
      event: { t: 'md', text: '{}' },
    }, loadItem)

    const record = value as Record<string, unknown>
    assert.equal(changed, true)
    assert.equal(record.kind, 'session_turn')
    assert.equal(record.ownerType, 'session')
    assert.equal(record.ownerId, 'sess_1')
    assert.equal(record.parentExecutionId, null)
  })
})
