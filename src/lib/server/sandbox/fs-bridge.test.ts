import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createSandboxFsBridge } from '@/lib/server/sandbox/fs-bridge'

test('sandbox fs bridge maps workspace files into the container workdir', () => {
  const bridge = createSandboxFsBridge({
    workspaceDir: '/tmp/project',
    containerWorkdir: '/workspace',
    workspaceAccess: 'rw',
  })

  const resolved = bridge.resolvePath({
    filePath: './pages/index.html',
    cwd: '/tmp/project/apps/site',
  })

  assert.equal(resolved.hostPath, path.resolve('/tmp/project/apps/site/pages/index.html'))
  assert.equal(resolved.containerPath, '/workspace/apps/site/pages/index.html')
  assert.equal(resolved.writable, true)
})

test('sandbox fs bridge maps extra upload mounts into container paths', () => {
  const bridge = createSandboxFsBridge({
    workspaceDir: '/tmp/project',
    containerWorkdir: '/workspace',
    workspaceAccess: 'rw',
    extraMounts: [{
      hostRoot: '/tmp/uploads',
      containerRoot: '/uploads',
      writable: false,
      source: 'uploads',
    }],
  })

  const resolved = bridge.resolvePath({
    filePath: '/tmp/uploads/proof.html',
    cwd: '/tmp/project',
  })

  assert.equal(resolved.containerPath, '/uploads/proof.html')
  assert.equal(resolved.writable, false)
})

test('sandbox fs bridge accepts container-root inputs directly', () => {
  const bridge = createSandboxFsBridge({
    workspaceDir: '/tmp/project',
    containerWorkdir: '/workspace',
    workspaceAccess: 'rw',
  })

  const resolved = bridge.resolvePath({
    filePath: 'sandbox:/workspace/reports/today.html',
    cwd: '/tmp/project',
  })

  assert.equal(resolved.hostPath, '/tmp/project/reports/today.html')
  assert.equal(resolved.containerPath, '/workspace/reports/today.html')
})
