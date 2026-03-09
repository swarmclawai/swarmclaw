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
  SWARMCLAW_DAEMON_BACKGROUND_SERVICES: process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES,
}

let tempDir = ''
let mod: typeof import('./daemon-state')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-daemon-state-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'
  mod = await import('./daemon-state')
})

after(() => {
  try { mod.stopDaemon({ source: 'test-cleanup' }) } catch { /* ignore */ }
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// ── shouldNotifyProviderReachabilityIssue ────────────────────────────────

describe('shouldNotifyProviderReachabilityIssue', () => {
  it('returns false for openclaw provider', () => {
    assert.equal(mod.shouldNotifyProviderReachabilityIssue('openclaw'), false)
  })

  it('returns true for other providers', () => {
    assert.equal(mod.shouldNotifyProviderReachabilityIssue('openai'), true)
    assert.equal(mod.shouldNotifyProviderReachabilityIssue('anthropic'), true)
    assert.equal(mod.shouldNotifyProviderReachabilityIssue('ollama'), true)
  })
})

// ── shouldSuppressSessionHeartbeatHealthAlert ───────────────────────────

describe('shouldSuppressSessionHeartbeatHealthAlert', () => {
  it('suppresses workbench user sessions', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'My Chat', user: 'workbench', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('suppresses comparison-bench user sessions', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'My Chat', user: 'comparison-bench', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('suppresses sessions with wb- prefix in id', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 'wb-test-123', name: 'My Chat', user: 'human', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('suppresses sessions with cmp- prefix in id', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 'cmp-test-456', name: 'My Chat', user: 'human', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('suppresses sessions with wb- prefix in shortcutForAgentId', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'My Chat', user: 'human', shortcutForAgentId: 'wb-agent' }),
      true,
    )
  })

  it('suppresses sessions named "workbench ..."', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'Workbench test run', user: 'human', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('suppresses sessions named "assistant benchmark ..."', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'Assistant Benchmark v2', user: 'human', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('suppresses sessions named "comparison ..."', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'Comparison run', user: 'human', shortcutForAgentId: undefined }),
      true,
    )
  })

  it('does not suppress normal sessions', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({ id: 's1', name: 'Daily standup', user: 'admin', shortcutForAgentId: undefined }),
      false,
    )
  })

  it('handles null/undefined user gracefully', () => {
    assert.equal(
      mod.shouldSuppressSessionHeartbeatHealthAlert({
        id: 's1',
        name: 'Chat',
        user: undefined as unknown as string,
        shortcutForAgentId: undefined,
      }),
      false,
    )
  })
})

// ── shouldSuppressSyntheticAgentHealthAlert ──────────────────────────────

describe('shouldSuppressSyntheticAgentHealthAlert', () => {
  it('suppresses wb- prefix agents', () => {
    assert.equal(mod.shouldSuppressSyntheticAgentHealthAlert('wb-test-agent'), true)
  })

  it('suppresses cmp- prefix agents', () => {
    assert.equal(mod.shouldSuppressSyntheticAgentHealthAlert('cmp-benchmark-agent'), true)
  })

  it('does not suppress normal agents', () => {
    assert.equal(mod.shouldSuppressSyntheticAgentHealthAlert('my-agent'), false)
  })

  it('is case-insensitive for prefix matching', () => {
    assert.equal(mod.shouldSuppressSyntheticAgentHealthAlert('WB-uppercase'), true)
    assert.equal(mod.shouldSuppressSyntheticAgentHealthAlert('CMP-upper'), true)
  })
})

// ── buildSessionHeartbeatHealthDedupKey ──────────────────────────────────

describe('buildSessionHeartbeatHealthDedupKey', () => {
  it('builds key for stale state', () => {
    assert.equal(
      mod.buildSessionHeartbeatHealthDedupKey('session-abc', 'stale'),
      'health-alert:session-heartbeat:stale:session-abc',
    )
  })

  it('builds key for auto-disabled state', () => {
    assert.equal(
      mod.buildSessionHeartbeatHealthDedupKey('session-xyz', 'auto-disabled'),
      'health-alert:session-heartbeat:auto-disabled:session-xyz',
    )
  })

  it('includes session id in key', () => {
    const key = mod.buildSessionHeartbeatHealthDedupKey('unique-id-42', 'stale')
    assert.ok(key.includes('unique-id-42'))
  })
})

// ── isDaemonBackgroundServicesEnabled ────────────────────────────────────

describe('isDaemonBackgroundServicesEnabled', () => {
  it('defaults to true when env var is not set', () => {
    const saved = process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    delete process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    try {
      assert.equal(mod.isDaemonBackgroundServicesEnabled(), true)
    } finally {
      if (saved !== undefined) process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = saved
    }
  })

  it('returns false when env var is "false"', () => {
    const saved = process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = 'false'
    try {
      assert.equal(mod.isDaemonBackgroundServicesEnabled(), false)
    } finally {
      if (saved !== undefined) process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = saved
      else delete process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    }
  })

  it('returns true when env var is "true"', () => {
    const saved = process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = 'true'
    try {
      assert.equal(mod.isDaemonBackgroundServicesEnabled(), true)
    } finally {
      if (saved !== undefined) process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = saved
      else delete process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    }
  })

  it('returns false when env var is "0"', () => {
    const saved = process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = '0'
    try {
      assert.equal(mod.isDaemonBackgroundServicesEnabled(), false)
    } finally {
      if (saved !== undefined) process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = saved
      else delete process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES
    }
  })
})

// ── ensureDaemonStarted ─────────────────────────────────────────────────

describe('ensureDaemonStarted', () => {
  it('returns false when autostart is disabled', () => {
    assert.equal(mod.ensureDaemonStarted('test'), false)
  })
})

// ── startDaemon / stopDaemon / getDaemonStatus ──────────────────────────

describe('daemon start/stop lifecycle', () => {
  it('getDaemonStatus shows not running initially', () => {
    mod.stopDaemon({ source: 'test' })
    const status = mod.getDaemonStatus()
    assert.equal(status.running, false)
  })

  it('startDaemon sets running to true', () => {
    mod.startDaemon({ source: 'test', manualStart: true })
    try {
      const status = mod.getDaemonStatus()
      assert.equal(status.running, true)
      assert.equal(status.schedulerActive, true)
    } finally {
      mod.stopDaemon({ source: 'test' })
    }
  })

  it('stopDaemon sets running to false', () => {
    mod.startDaemon({ source: 'test', manualStart: true })
    mod.stopDaemon({ source: 'test' })
    const status = mod.getDaemonStatus()
    assert.equal(status.running, false)
  })

  it('double startDaemon does not throw', () => {
    mod.startDaemon({ source: 'test', manualStart: true })
    try {
      assert.doesNotThrow(() => mod.startDaemon({ source: 'test-again' }))
      const status = mod.getDaemonStatus()
      assert.equal(status.running, true)
    } finally {
      mod.stopDaemon({ source: 'test' })
    }
  })

  it('manualStop prevents ensureDaemonStarted from restarting', () => {
    const saved = process.env.SWARMCLAW_DAEMON_AUTOSTART
    process.env.SWARMCLAW_DAEMON_AUTOSTART = '1'
    try {
      mod.startDaemon({ source: 'test', manualStart: true })
      mod.stopDaemon({ source: 'test', manualStop: true })
      const started = mod.ensureDaemonStarted('test')
      assert.equal(started, false)
      assert.equal(mod.getDaemonStatus().running, false)
    } finally {
      mod.stopDaemon({ source: 'cleanup' })
      if (saved !== undefined) process.env.SWARMCLAW_DAEMON_AUTOSTART = saved
      else delete process.env.SWARMCLAW_DAEMON_AUTOSTART
    }
  })

  it('getDaemonStatus includes heartbeat and health info', () => {
    mod.startDaemon({ source: 'test', manualStart: true })
    try {
      const status = mod.getDaemonStatus()
      assert.ok('heartbeat' in status)
      assert.ok('health' in status)
      assert.ok('queueLength' in status)
      assert.ok('autostartEnabled' in status)
      assert.ok('backgroundServicesEnabled' in status)
    } finally {
      mod.stopDaemon({ source: 'test' })
    }
  })

  it('stopDaemon is idempotent', () => {
    mod.stopDaemon({ source: 'first' })
    assert.doesNotThrow(() => mod.stopDaemon({ source: 'second' }))
    assert.equal(mod.getDaemonStatus().running, false)
  })
})
