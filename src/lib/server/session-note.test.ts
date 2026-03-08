import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSessionNoteMessage } from './session-note'

test('buildSessionNoteMessage defaults to assistant/system note metadata', () => {
  const result = buildSessionNoteMessage({
    text: 'Live test passed',
  })

  assert.ok(result)
  assert.equal(result?.role, 'assistant')
  assert.equal(result?.kind, 'system')
  assert.equal(result?.text, 'Live test passed')
  assert.equal(typeof result?.time, 'number')
})

test('buildSessionNoteMessage trims text and preserves explicit role/kind', () => {
  const result = buildSessionNoteMessage({
    text: '  Visible smoke report  ',
    role: 'user',
    kind: 'chat',
    time: 123,
  })

  assert.deepEqual(result, {
    role: 'user',
    kind: 'chat',
    text: 'Visible smoke report',
    time: 123,
  })
})

test('buildSessionNoteMessage returns null for empty text', () => {
  assert.equal(buildSessionNoteMessage({ text: '   ' }), null)
})
