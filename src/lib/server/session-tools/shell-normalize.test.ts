import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeShellArgs, rewriteShellWorkspaceAliases, stripManagedBackgroundSuffix } from './shell'

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

describe('rewriteShellWorkspaceAliases', () => {
  it('maps /workspace paths inside shell commands to the session cwd', () => {
    const out = rewriteShellWorkspaceAliases('/tmp/agent-workspace', 'cd /workspace/research && ls /workspace/file.md')
    assert.equal(out, 'cd /tmp/agent-workspace/research && ls /tmp/agent-workspace/file.md')
  })

  it('maps workspace/ relative aliases without touching unrelated text', () => {
    const out = rewriteShellWorkspaceAliases('/tmp/agent-workspace', 'cat workspace/topics/one.md && echo https://example.com/workspace/demo')
    assert.equal(out, 'cat /tmp/agent-workspace/topics/one.md && echo https://example.com/workspace/demo')
  })
})

describe('stripManagedBackgroundSuffix', () => {
  it('removes a trailing ampersand for managed background commands', () => {
    const out = stripManagedBackgroundSuffix('python3 -m http.server 8001 &')
    assert.equal(out, 'python3 -m http.server 8001')
  })

  it('leaves ordinary commands untouched', () => {
    const out = stripManagedBackgroundSuffix('npm run build')
    assert.equal(out, 'npm run build')
  })
})
