import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeShellArgs } from './shell'

describe('normalizeShellArgs', () => {
  it('keeps explicit action + command', () => {
    const out = normalizeShellArgs({ action: 'execute', command: 'pwd' })
    assert.equal(out.action, 'execute')
    assert.equal(out.command, 'pwd')
  })

  it('maps top-level execute_command to execute action', () => {
    const out = normalizeShellArgs({ execute_command: 'ls -la' })
    assert.equal(out.action, 'execute')
    assert.equal(out.command, 'ls -la')
  })

  it('maps nested input.execute_command payload', () => {
    const out = normalizeShellArgs({
      input: {
        execute_command: 'cd openclaw/site && ls -la',
      },
    })
    assert.equal(out.action, 'execute')
    assert.equal(out.command, 'cd openclaw/site && ls -la')
  })

  it('maps stringified input payload', () => {
    const out = normalizeShellArgs({
      input: JSON.stringify({ execute_command: 'echo hello' }),
    })
    assert.equal(out.action, 'execute')
    assert.equal(out.command, 'echo hello')
  })

  it('maps args wrapper payload', () => {
    const out = normalizeShellArgs({
      args: { execute_command: 'pwd' },
    })
    assert.equal(out.action, 'execute')
    assert.equal(out.command, 'pwd')
  })
})
