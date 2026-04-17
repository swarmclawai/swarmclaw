import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { Message } from '@/types'
import {
  CLEAR_UNDO_TTL_MS,
  __resetClearUndoSnapshotsForTests,
  consumeClearUndoSnapshot,
  recordClearUndoSnapshot,
  type ClearUndoCliIds,
} from './clear-undo-snapshots'

function makeMsg(text: string): Message {
  return { role: 'user', text, time: Date.now() }
}

const emptyCli: ClearUndoCliIds = {
  claudeSessionId: null,
  codexThreadId: null,
  opencodeSessionId: null,
  opencodeWebSessionId: null,
  geminiSessionId: null,
  copilotSessionId: null,
  droidSessionId: null,
  cursorSessionId: null,
  qwenSessionId: null,
  acpSessionId: null,
  delegateResumeIds: null,
}

describe('clear-undo-snapshots', () => {
  afterEach(() => {
    __resetClearUndoSnapshotsForTests()
  })

  it('records and consumes a snapshot within the TTL window', () => {
    const sessionId = 'sess_test_1'
    const messages = [makeMsg('hello'), makeMsg('world')]
    const { token, expiresAt } = recordClearUndoSnapshot({ sessionId, messages, cli: emptyCli })
    assert.match(token, /^undo_/)
    assert.ok(expiresAt > Date.now())
    const snapshot = consumeClearUndoSnapshot({ token, sessionId })
    assert.ok(snapshot)
    assert.equal(snapshot.messages.length, 2)
  })

  it('single-use: a consumed snapshot cannot be consumed again', () => {
    const sessionId = 'sess_test_2'
    const { token } = recordClearUndoSnapshot({
      sessionId,
      messages: [makeMsg('hi')],
      cli: emptyCli,
    })
    const first = consumeClearUndoSnapshot({ token, sessionId })
    assert.ok(first)
    const second = consumeClearUndoSnapshot({ token, sessionId })
    assert.equal(second, null)
  })

  it('rejects a consume with a mismatched sessionId', () => {
    const { token } = recordClearUndoSnapshot({
      sessionId: 'sess_owner',
      messages: [makeMsg('hi')],
      cli: emptyCli,
    })
    const hijacked = consumeClearUndoSnapshot({ token, sessionId: 'sess_other' })
    assert.equal(hijacked, null)
  })

  it('rejects an expired snapshot and sweeps it from the store', () => {
    const base = 1_000_000
    const { token } = recordClearUndoSnapshot({
      sessionId: 'sess_expire',
      messages: [makeMsg('stale')],
      cli: emptyCli,
      now: base,
    })
    const expired = consumeClearUndoSnapshot({
      token,
      sessionId: 'sess_expire',
      now: base + CLEAR_UNDO_TTL_MS + 1,
    })
    assert.equal(expired, null)
    // Same token is now gone from the store entirely
    const again = consumeClearUndoSnapshot({ token, sessionId: 'sess_expire', now: base })
    assert.equal(again, null)
  })

  it('preserves CLI session IDs and delegateResumeIds across record/consume', () => {
    const cli: ClearUndoCliIds = {
      ...emptyCli,
      claudeSessionId: 'cs_abc',
      codexThreadId: 'cx_def',
      delegateResumeIds: { claudeCode: 'resume_123', codex: null },
    }
    const { token } = recordClearUndoSnapshot({
      sessionId: 'sess_cli',
      messages: [],
      cli,
    })
    const snapshot = consumeClearUndoSnapshot({ token, sessionId: 'sess_cli' })
    assert.ok(snapshot)
    assert.equal(snapshot.cli.claudeSessionId, 'cs_abc')
    assert.equal(snapshot.cli.codexThreadId, 'cx_def')
    assert.equal(snapshot.cli.delegateResumeIds?.claudeCode, 'resume_123')
  })
})
