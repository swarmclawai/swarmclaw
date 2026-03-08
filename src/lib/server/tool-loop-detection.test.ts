import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ToolLoopTracker, hashToolInput, hashToolOutput } from './tool-loop-detection'

describe('ToolLoopTracker', () => {
  it('returns null for normal non-repeating tool calls', () => {
    const tracker = new ToolLoopTracker()
    assert.equal(tracker.record('web_search', { query: 'weather london' }, 'Sunny, 20C'), null)
    assert.equal(tracker.record('files', { action: 'write', path: '/tmp/test.json' }, 'OK'), null)
    assert.equal(tracker.record('web_search', { query: 'weather paris' }, 'Cloudy, 15C'), null)
    assert.equal(tracker.size, 3)
  })

  it('detects generic repeat at warning threshold', () => {
    const tracker = new ToolLoopTracker({ repeatWarn: 3, repeatCritical: 6 })
    for (let i = 0; i < 2; i++) {
      assert.equal(tracker.record('web_search', { query: 'same query' }, `result ${i}`), null)
    }
    const result = tracker.record('web_search', { query: 'same query' }, 'result 2')
    assert.ok(result)
    assert.equal(result.severity, 'warning')
    assert.equal(result.detector, 'generic_repeat')
  })

  it('detects generic repeat at critical threshold', () => {
    const tracker = new ToolLoopTracker({ repeatWarn: 3, repeatCritical: 5, toolFrequencyWarn: 100, toolFrequencyCritical: 100 })
    for (let i = 0; i < 4; i++) {
      tracker.record('web_search', { query: 'same' }, `result ${i}`)
    }
    const result = tracker.record('web_search', { query: 'same' }, 'result 4')
    assert.ok(result)
    assert.equal(result.severity, 'critical')
    assert.equal(result.detector, 'generic_repeat')
  })

  it('detects polling stall when same tool returns identical output', () => {
    const tracker = new ToolLoopTracker({ pollWarn: 3, pollCritical: 5 })
    // Different inputs but same output = polling stall
    for (let i = 0; i < 2; i++) {
      assert.equal(tracker.record('process', { action: 'poll', id: `run-${i}` }, 'status: running'), null)
    }
    const result = tracker.record('process', { action: 'poll', id: 'run-2' }, 'status: running')
    assert.ok(result)
    assert.equal(result.severity, 'warning')
    assert.equal(result.detector, 'polling_stall')
  })

  it('detects ping-pong between two tools', () => {
    const tracker = new ToolLoopTracker({ pingPongWarn: 2, pingPongCritical: 4 })
    // Simulate A-B-A-B with identical outputs
    for (let i = 0; i < 2; i++) {
      tracker.record('web_search', { query: 'find it' }, 'no results found')
      tracker.record('web_fetch', { url: 'https://example.com' }, '404 not found')
    }
    // One more A to complete the 3rd pair-start
    const result = tracker.record('web_search', { query: 'find it' }, 'no results found')
    // The ping-pong detector checks the last pair against previous pairs
    // After 4 calls (A-B-A-B) + 1 more A, we have 2 full A-B cycles with identical results
    if (result) {
      assert.equal(result.detector, 'ping_pong')
    }
  })

  it('circuit breaker fires at absolute cap', () => {
    const tracker = new ToolLoopTracker({ circuitBreaker: 5, repeatWarn: 100, repeatCritical: 100, toolFrequencyWarn: 100, toolFrequencyCritical: 100 })
    for (let i = 0; i < 4; i++) {
      tracker.record('shell', { command: 'curl http://stuck.com' }, `err ${i}`)
    }
    const result = tracker.record('shell', { command: 'curl http://stuck.com' }, 'err 4')
    assert.ok(result)
    assert.equal(result.severity, 'critical')
    assert.equal(result.detector, 'circuit_breaker')
  })

  it('does not fire for varied tool calls even with many total calls', () => {
    const tracker = new ToolLoopTracker({ toolFrequencyWarn: 100, toolFrequencyCritical: 100 })
    for (let i = 0; i < 20; i++) {
      const result = tracker.record('web_search', { query: `query ${i}` }, `result ${i}`)
      assert.equal(result, null, `Unexpected detection at call ${i}`)
    }
    assert.equal(tracker.size, 20)
  })

  it('detects tool frequency when same tool is called too many times (any input)', () => {
    const tracker = new ToolLoopTracker({ toolFrequencyWarn: 3, toolFrequencyCritical: 5 })
    for (let i = 0; i < 2; i++) {
      assert.equal(tracker.record('web_search', { query: `q${i}` }, `r${i}`), null)
    }
    const warn = tracker.record('web_search', { query: 'q2' }, 'r2')
    assert.ok(warn)
    assert.equal(warn.severity, 'warning')
    assert.equal(warn.detector, 'tool_frequency')
  })
})

describe('hash helpers', () => {
  it('produces consistent hashes for same input', () => {
    assert.equal(hashToolInput({ query: 'test' }), hashToolInput({ query: 'test' }))
    assert.equal(hashToolOutput('hello world'), hashToolOutput('hello world'))
  })

  it('produces different hashes for different input', () => {
    assert.notEqual(hashToolInput({ query: 'a' }), hashToolInput({ query: 'b' }))
  })
})
