import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  buildDockerExecArgs,
  clearManagedProcess,
  getManagedProcess,
  getShellCommand,
  listManagedProcesses,
  startManagedProcess,
} from '@/lib/server/runtime/process-manager'
import { clearDockerDetectCache } from '@/lib/server/sandbox/docker-detect'

const originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  clearDockerDetectCache()
  for (const rec of listManagedProcesses()) {
    clearManagedProcess(rec.id)
  }
})

test('sandboxed processes fail cleanly when docker is unavailable', async () => {
  process.env.PATH = ''
  clearDockerDetectCache()

  const result = await startManagedProcess({
    command: 'echo hello',
    cwd: process.cwd(),
    env: { PATH: '' },
    timeoutMs: 2_000,
    yieldMs: 2_000,
    sandbox: {
      image: 'alpine:3.20',
      network: 'none',
      memoryMb: 64,
      cpus: 1,
      readonlyRoot: true,
      workspaceMounts: [],
    },
  })

  await delay(25)

  assert.equal(result.status, 'completed')
  assert.equal(result.exitCode, 1)
  assert.match(result.output || '', /Spawn error: spawn docker ENOENT/)

  const record = getManagedProcess(result.processId)
  assert.equal(record?.status, 'failed')
})

test('persistent sandboxes use docker exec with container workdir and env passthrough', () => {
  const shell = getShellCommand('pwd', 'proc-1', {
    kind: 'persistent',
    containerName: 'swarmclaw-sb-session',
    containerWorkdir: '/workspace/apps/web',
    env: {
      HOME: '/workspace',
      PATH: '/custom/bin:/usr/local/bin',
    },
  })

  assert.equal(shell.shell, 'docker')
  assert.deepEqual(shell.args.slice(0, 4), ['exec', '-i', '-w', '/workspace/apps/web'])
  assert.ok(shell.args.includes('swarmclaw-sb-session'))
  assert.ok(shell.args.includes('SWARMCLAW_PREPEND_PATH=/custom/bin:/usr/local/bin'))
  assert.match(shell.args.at(-1) || '', /export PATH="\$\{SWARMCLAW_PREPEND_PATH\}:\$PATH"; unset SWARMCLAW_PREPEND_PATH; pwd/)
})

test('buildDockerExecArgs preserves container env without interpolating PATH into the command', () => {
  const args = buildDockerExecArgs({
    containerName: 'sandbox-1',
    command: 'echo hello',
    workdir: '/workspace',
    env: {
      HOME: '/workspace',
      PATH: '$(touch /tmp/swarmclaw-path-injection)',
    },
  })

  assert.ok(args.includes('SWARMCLAW_PREPEND_PATH=$(touch /tmp/swarmclaw-path-injection)'))
  assert.equal((args.at(-1) || '').includes('$(touch /tmp/swarmclaw-path-injection)'), false)
  assert.match(args.at(-1) || '', /SWARMCLAW_PREPEND_PATH/)
})
