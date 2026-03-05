import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolInputArgs } from './normalize-tool-args'

describe('normalizeToolInputArgs', () => {
  it('keeps top-level args as-is when there is no wrapper', () => {
    const out = normalizeToolInputArgs({ action: 'list', path: '/tmp' })
    assert.equal(out.action, 'list')
    assert.equal(out.path, '/tmp')
  })

  it('merges nested input object payloads', () => {
    const out = normalizeToolInputArgs({
      input: {
        action: 'execute',
        execute_command: 'pwd',
      },
    })
    assert.equal(out.action, 'execute')
    assert.equal(out.execute_command, 'pwd')
  })

  it('merges stringified input payloads', () => {
    const out = normalizeToolInputArgs({
      input: JSON.stringify({
        action: 'list',
        path: '/Users/dev/project',
      }),
    })
    assert.equal(out.action, 'list')
    assert.equal(out.path, '/Users/dev/project')
  })

  it('supports args/payload wrapper aliases', () => {
    const out = normalizeToolInputArgs({
      args: { action: 'read', filePath: 'README.md' },
      payload: { limit: 10 },
    })
    assert.equal(out.action, 'read')
    assert.equal(out.filePath, 'README.md')
    assert.equal(out.limit, 10)
  })

  it('keeps explicit top-level values over nested wrappers', () => {
    const out = normalizeToolInputArgs({
      action: 'top-level',
      input: { action: 'nested' },
    })
    assert.equal(out.action, 'top-level')
  })

  it('preserves falsey top-level values', () => {
    const out = normalizeToolInputArgs({
      input: { limit: 5, approved: true },
      limit: 0,
      approved: false,
    })
    assert.equal(out.limit, 0)
    assert.equal(out.approved, false)
  })
})
