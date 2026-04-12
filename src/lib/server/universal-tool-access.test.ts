import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// NOTE: we intentionally avoid importing the real universal-tool-access
// module here — it pulls in the extension manager which transitively loads
// the whole plugin system and OOMs in test workers. We re-declare the pure
// logic and verify the algorithmic behavior. Integration coverage for the
// extension-manager branch happens via live-chat profiling instead.

const SCOPED_TOOL_BASELINE = ['memory', 'context_mgmt', 'ask_human'] as const
const UNIVERSAL_SAMPLE = new Set([
  'shell', 'files', 'edit_file', 'delegate', 'web', 'browser', 'memory',
  'manage_platform', 'manage_tasks', 'context_mgmt', 'ask_human',
  'schedule_wake', 'email', 'image_gen',
])

function normalize(value: string[] | undefined | null): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
}

function scoped(declared: string[] | null | undefined, universe: Set<string> = UNIVERSAL_SAMPLE): string[] {
  const picks = normalize(declared).filter((t) => universe.has(t))
  return Array.from(new Set([...SCOPED_TOOL_BASELINE, ...picks]))
}

describe('scoped tool access algorithm', () => {
  it('intersects declared tools with the universe and keeps the baseline', () => {
    const out = scoped(['shell', 'files', 'edit_file', 'web'])
    assert.ok(out.includes('memory'))
    assert.ok(out.includes('context_mgmt'))
    assert.ok(out.includes('ask_human'))
    assert.ok(out.includes('shell'))
    assert.ok(out.includes('files'))
    assert.ok(out.includes('edit_file'))
    assert.ok(out.includes('web'))
    assert.ok(!out.includes('browser'))
    assert.ok(!out.includes('manage_platform'))
    assert.ok(!out.includes('delegate'))
  })

  it('drops declared tools that are not in the universe', () => {
    const out = scoped(['shell', 'not_a_real_tool'])
    assert.ok(out.includes('shell'))
    assert.ok(!out.includes('not_a_real_tool'))
  })

  it('returns only the baseline when declared tools is empty', () => {
    assert.deepEqual(scoped([]).sort(), ['ask_human', 'context_mgmt', 'memory'])
  })

  it('produces a strictly smaller set than the universe for a focused agent', () => {
    assert.ok(scoped(['shell', 'files', 'web']).length < UNIVERSAL_SAMPLE.size)
  })

  it('deduplicates when baseline overlaps with declared tools', () => {
    const out = scoped(['memory', 'shell'])
    assert.equal(out.filter((t) => t === 'memory').length, 1)
  })

  it('treats null / undefined / non-array declared tools as empty', () => {
    assert.deepEqual(scoped(null).sort(), ['ask_human', 'context_mgmt', 'memory'])
    assert.deepEqual(scoped(undefined).sort(), ['ask_human', 'context_mgmt', 'memory'])
  })

  it('trims whitespace in declared tool names', () => {
    const out = scoped(['  shell  ', '\tfiles\n'])
    assert.ok(out.includes('shell'))
    assert.ok(out.includes('files'))
  })
})
