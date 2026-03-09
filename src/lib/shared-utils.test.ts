import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  errorMessage,
  safeJsonParse,
  truncate,
  hmrSingleton,
  dedup,
  dedupBy,
  sleep,
} from './shared-utils'

describe('errorMessage', () => {
  it('extracts message from Error', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom')
  })
  it('converts string to string', () => {
    assert.equal(errorMessage('fail'), 'fail')
  })
  it('converts number to string', () => {
    assert.equal(errorMessage(42), '42')
  })
  it('converts null to string', () => {
    assert.equal(errorMessage(null), 'null')
  })
  it('converts undefined to string', () => {
    assert.equal(errorMessage(undefined), 'undefined')
  })
  it('handles TypeError subclass', () => {
    assert.equal(errorMessage(new TypeError('bad type')), 'bad type')
  })
})

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(safeJsonParse('{"a":1}', null), { a: 1 })
  })
  it('returns fallback for invalid JSON', () => {
    assert.equal(safeJsonParse('not json', 'default'), 'default')
  })
  it('returns fallback for empty string', () => {
    assert.deepEqual(safeJsonParse('', []), [])
  })
  it('parses arrays', () => {
    assert.deepEqual(safeJsonParse('[1,2,3]', []), [1, 2, 3])
  })
  it('parses null literal', () => {
    assert.equal(safeJsonParse('null', 'fallback'), null)
  })
})

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    assert.equal(truncate('hello', 10), 'hello')
  })
  it('truncates long strings', () => {
    assert.equal(truncate('hello world', 5), 'hello')
  })
  it('truncates with suffix', () => {
    assert.equal(truncate('hello world', 8, '…'), 'hello w…')
  })
  it('handles exact limit', () => {
    assert.equal(truncate('hello', 5), 'hello')
  })
  it('handles zero limit', () => {
    assert.equal(truncate('hello', 0), '')
  })
  it('handles suffix longer than limit gracefully', () => {
    assert.equal(truncate('hello world', 2, '...'), '...')
  })
  it('empty string unchanged', () => {
    assert.equal(truncate('', 10), '')
  })
})

describe('hmrSingleton', () => {
  it('creates and returns a value', () => {
    const val = hmrSingleton('__test_hmr_1__', () => ({ count: 0 }))
    assert.deepEqual(val, { count: 0 })
  })
  it('returns same instance on second call', () => {
    const a = hmrSingleton('__test_hmr_2__', () => ({ id: Math.random() }))
    const b = hmrSingleton('__test_hmr_2__', () => ({ id: Math.random() }))
    assert.equal(a, b)
    assert.equal(a.id, b.id)
  })
  it('creates different instances for different keys', () => {
    const a = hmrSingleton('__test_hmr_3a__', () => 'a')
    const b = hmrSingleton('__test_hmr_3b__', () => 'b')
    assert.notEqual(a, b)
  })
})

describe('dedup', () => {
  it('removes duplicates', () => {
    assert.deepEqual(dedup([1, 2, 2, 3, 1]), [1, 2, 3])
  })
  it('preserves order', () => {
    assert.deepEqual(dedup(['b', 'a', 'b', 'c']), ['b', 'a', 'c'])
  })
  it('handles empty array', () => {
    assert.deepEqual(dedup([]), [])
  })
  it('handles all unique', () => {
    assert.deepEqual(dedup([1, 2, 3]), [1, 2, 3])
  })
})

describe('dedupBy', () => {
  it('deduplicates by key function', () => {
    const items = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
      { id: '1', name: 'c' },
    ]
    const result = dedupBy(items, (i) => i.id)
    assert.equal(result.length, 2)
    assert.equal(result[0].name, 'a')
    assert.equal(result[1].name, 'b')
  })
  it('keeps first occurrence', () => {
    const result = dedupBy(['hello', 'HELLO', 'world'], (s) => s.toLowerCase())
    assert.deepEqual(result, ['hello', 'world'])
  })
  it('handles empty array', () => {
    assert.deepEqual(dedupBy([], (x) => String(x)), [])
  })
})

describe('sleep', () => {
  it('resolves after delay', async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 40, `Expected ≥40ms, got ${elapsed}ms`)
  })
  it('resolves with undefined', async () => {
    const result = await sleep(1)
    assert.equal(result, undefined)
  })
})
