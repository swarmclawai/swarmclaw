import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
  SWARMCLAW_DAEMON_AUTOSTART: process.env.SWARMCLAW_DAEMON_AUTOSTART,
}

let tempDir = ''
let policy: typeof import('@/lib/server/runtime/daemon-policy')
let storage: typeof import('@/lib/server/storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-daemon-policy-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  delete process.env.SWARMCLAW_DAEMON_AUTOSTART

  storage = await import('@/lib/server/storage')
  policy = await import('@/lib/server/runtime/daemon-policy')
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('daemonAutostartEnvEnabled', () => {
  it('defaults to enabled when neither env nor app settings override it', () => {
    delete process.env.SWARMCLAW_DAEMON_AUTOSTART
    storage.saveSettings({})

    assert.equal(policy.daemonAutostartEnvEnabled(), true)
  })

  it('reads the persisted app setting when env is unset', () => {
    delete process.env.SWARMCLAW_DAEMON_AUTOSTART
    storage.saveSettings({ daemonAutostartEnabled: false })
    assert.equal(policy.daemonAutostartEnvEnabled(), false)

    storage.saveSettings({ daemonAutostartEnabled: true })
    assert.equal(policy.daemonAutostartEnvEnabled(), true)
  })

  it('lets the environment variable override the persisted app setting', () => {
    storage.saveSettings({ daemonAutostartEnabled: true })
    process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'
    assert.equal(policy.daemonAutostartEnvEnabled(), false)

    process.env.SWARMCLAW_DAEMON_AUTOSTART = '1'
    assert.equal(policy.daemonAutostartEnvEnabled(), true)
  })
})
