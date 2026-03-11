import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSandboxRuntimeStatus, resolveSandboxWorkdir } from '@/lib/server/sandbox/session-runtime'

test('resolveSandboxRuntimeStatus defaults enabled sandboxes to all sessions', () => {
  const status = resolveSandboxRuntimeStatus({
    config: { enabled: true },
    session: {
      id: 'session-1',
      agentId: 'agent-1',
      parentSessionId: 'parent-1',
    } as any,
  })

  assert.equal(status.mode, 'all')
  assert.equal(status.sandboxed, true)
  assert.equal(status.scope, 'session')
  assert.equal(status.scopeKey, 'session:session-1')
})

test('resolveSandboxRuntimeStatus skips the main session in non-main mode', () => {
  const status = resolveSandboxRuntimeStatus({
    config: { enabled: true, mode: 'non-main' },
    session: {
      id: 'main-session',
      agentId: 'agent-1',
      heartbeatEnabled: true,
    } as any,
  })

  assert.equal(status.mode, 'non-main')
  assert.equal(status.sandboxed, false)
  assert.equal(status.scopeKey, 'session:main-session')
})

test('resolveSandboxRuntimeStatus sandboxes child sessions in non-main mode', () => {
  const status = resolveSandboxRuntimeStatus({
    config: { enabled: true, mode: 'non-main', scope: 'agent' },
    session: {
      id: 'child-session',
      agentId: 'agent-1',
      parentSessionId: 'main-session',
    } as any,
  })

  assert.equal(status.sandboxed, true)
  assert.equal(status.scope, 'agent')
  assert.equal(status.scopeKey, 'agent:agent-1')
})

test('resolveSandboxWorkdir maps nested host paths into the container workspace', () => {
  const resolved = resolveSandboxWorkdir({
    workspaceDir: '/tmp/project',
    hostWorkdir: '/tmp/project/scripts/runner',
    containerWorkdir: '/workspace',
  })

  assert.equal(resolved.hostWorkdir, '/tmp/project/scripts/runner')
  assert.equal(resolved.containerWorkdir, '/workspace/scripts/runner')
})

test('resolveSandboxWorkdir falls back to the sandbox root for paths outside the workspace', () => {
  const resolved = resolveSandboxWorkdir({
    workspaceDir: '/tmp/project',
    hostWorkdir: '/tmp/elsewhere',
    containerWorkdir: '/workspace',
  })

  assert.equal(resolved.hostWorkdir, '/tmp/project')
  assert.equal(resolved.containerWorkdir, '/workspace')
})
