import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let mod: typeof import('@/lib/server/runtime/heartbeat-service')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-heartbeat-svc-'))
  workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/runtime/heartbeat-service')
})

after(() => {
  // Stop the service in case any test started it
  try { mod.stopHeartbeatService() } catch { /* ignore */ }
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// ── stripBlockedItems ───────────────────────────────────────────────────

describe('stripBlockedItems', () => {
  it('returns empty string for empty input', () => {
    assert.equal(mod.stripBlockedItems(''), '')
  })

  it('removes list items with (blocked) marker', () => {
    const input = '- Task A\n- Task B (blocked, no update)\n- Task C'
    const result = mod.stripBlockedItems(input)
    assert.ok(result.includes('Task A'))
    assert.ok(!result.includes('Task B'))
    assert.ok(result.includes('Task C'))
  })

  it('removes items with various blocked formats', () => {
    const input = [
      '- Normal item',
      '* Blocked one (blocked: awaiting approval)',
      '+ Another (blocked by dependency)',
      '- Keep this',
    ].join('\n')
    const result = mod.stripBlockedItems(input)
    assert.ok(!result.includes('Blocked one'))
    assert.ok(!result.includes('Another (blocked'))
    assert.ok(result.includes('Normal item'))
    assert.ok(result.includes('Keep this'))
  })

  it('preserves headers even if they mention blocked', () => {
    const input = '## Blocked Tasks\n- Item (blocked)'
    const result = mod.stripBlockedItems(input)
    assert.ok(result.includes('## Blocked Tasks'))
    assert.ok(!result.includes('- Item'))
  })

  it('preserves non-list lines mentioning blocked', () => {
    const input = 'Some blocked context text\n- Real blocked item (blocked)'
    const result = mod.stripBlockedItems(input)
    assert.ok(result.includes('Some blocked context'))
    assert.ok(!result.includes('Real blocked'))
  })
})

// ── isHeartbeatContentEffectivelyEmpty ───────────────────────────────────

describe('isHeartbeatContentEffectivelyEmpty', () => {
  it('returns true for null/undefined/empty', () => {
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty(null), true)
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty(undefined), true)
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty(''), true)
  })

  it('returns true for headers only', () => {
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty('# Title\n## Subtitle\n### H3'), true)
  })

  it('returns true for empty list items', () => {
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty('- \n* \n+ '), true)
  })

  it('returns true for empty checkboxes', () => {
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty('- [ ] \n- [x] '), true)
  })

  it('returns false for content with real text', () => {
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty('# Title\n- Do something useful'), false)
  })

  it('returns false for plain text', () => {
    assert.equal(mod.isHeartbeatContentEffectivelyEmpty('Run the backup job'), false)
  })
})

// ── buildIdentityContext ────────────────────────────────────────────────

describe('buildIdentityContext', () => {
  it('returns empty string when no identity fields', () => {
    assert.equal(mod.buildIdentityContext({}, {}), '')
  })

  it('builds context from agent fields', () => {
    const result = mod.buildIdentityContext(null, { name: 'Bot', emoji: '🤖' })
    assert.ok(result.includes('## Your Identity'))
    assert.ok(result.includes('Name: Bot'))
  })

  it('prefers file identity fields over agent fields', () => {
    // Without an actual IDENTITY.md on disk, file fields will be empty,
    // so agent fields should be used as fallback
    const result = mod.buildIdentityContext({ cwd: workspaceDir }, { name: 'Agent', vibe: 'chill' })
    assert.ok(result.includes('Name: Agent'))
    assert.ok(result.includes('Vibe: chill'))
  })

  it('reads IDENTITY.md from session cwd when present', () => {
    const identityPath = path.join(workspaceDir, 'IDENTITY.md')
    fs.writeFileSync(identityPath, '- **Name**: FileBot\n- **Emoji**: 🐛\n')
    try {
      const result = mod.buildIdentityContext({ cwd: workspaceDir }, { name: 'Agent' })
      assert.ok(result.includes('Name: FileBot'))
    } finally {
      fs.unlinkSync(identityPath)
    }
  })
})

// ── readHeartbeatFile ───────────────────────────────────────────────────

describe('readHeartbeatFile', () => {
  it('returns empty string when no HEARTBEAT.md', () => {
    assert.equal(mod.readHeartbeatFile({ cwd: workspaceDir }), '')
  })

  it('reads HEARTBEAT.md from session cwd', () => {
    const hbPath = path.join(workspaceDir, 'HEARTBEAT.md')
    fs.writeFileSync(hbPath, '# Tasks\n- Check logs')
    try {
      const result = mod.readHeartbeatFile({ cwd: workspaceDir })
      assert.ok(result.includes('Check logs'))
    } finally {
      fs.unlinkSync(hbPath)
    }
  })
})

// ── heartbeatConfigForSession ───────────────────────────────────────────

describe('heartbeatConfigForSession', () => {
  it('uses global defaults when no overrides', () => {
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1' },
      { heartbeatIntervalSec: 60 },
      {},
    )
    assert.equal(cfg.intervalSec, 60)
    assert.equal(cfg.enabled, true)
  })

  it('disables when interval is 0', () => {
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1' },
      { heartbeatIntervalSec: 0 },
      {},
    )
    assert.equal(cfg.enabled, false)
  })

  it('agent layer overrides global settings', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatIntervalSec: 120, heartbeatEnabled: true, heartbeatPrompt: 'Custom agent prompt' },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1' },
      { heartbeatIntervalSec: 60 },
      agents,
    )
    assert.equal(cfg.intervalSec, 120)
    assert.equal(cfg.prompt, 'Custom agent prompt')
  })

  it('agent can disable heartbeat', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatEnabled: false },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1' },
      { heartbeatIntervalSec: 60 },
      agents,
    )
    assert.equal(cfg.enabled, false)
  })

  it('session layer overrides agent settings', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatEnabled: true },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1', heartbeatEnabled: false },
      { heartbeatIntervalSec: 60 },
      agents,
    )
    assert.equal(cfg.enabled, false)
  })

  it('session interval overrides agent interval', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatIntervalSec: 120 },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1', heartbeatIntervalSec: 300 },
      { heartbeatIntervalSec: 60 },
      agents,
    )
    assert.equal(cfg.intervalSec, 300)
  })

  it('supports duration string format for interval', () => {
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1' },
      { heartbeatInterval: '1h30m' },
      {},
    )
    assert.equal(cfg.intervalSec, 5400) // 1h30m = 5400s
  })

  it('resolves model from settings and agent layers', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatModel: 'gpt-4' },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1' },
      { heartbeatIntervalSec: 60, heartbeatModel: 'gpt-3.5' },
      agents,
    )
    assert.equal(cfg.model, 'gpt-4')
  })

  it('returns showOk and showAlerts defaults', () => {
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1' },
      { heartbeatIntervalSec: 60 },
      {},
    )
    assert.equal(cfg.showOk, false)
    assert.equal(cfg.showAlerts, true)
  })
})

// ── start/stop/status service lifecycle ─────────────────────────────────

describe('heartbeat service lifecycle', () => {
  it('reports not running initially', () => {
    // Stop in case a previous test left it running
    mod.stopHeartbeatService()
    const status = mod.getHeartbeatServiceStatus()
    assert.equal(status.running, false)
  })

  it('start sets running to true', () => {
    mod.startHeartbeatService()
    try {
      const status = mod.getHeartbeatServiceStatus()
      assert.equal(status.running, true)
    } finally {
      mod.stopHeartbeatService()
    }
  })

  it('stop sets running to false', () => {
    mod.startHeartbeatService()
    mod.stopHeartbeatService()
    const status = mod.getHeartbeatServiceStatus()
    assert.equal(status.running, false)
  })

  it('restart clears tracked sessions and restarts', () => {
    mod.startHeartbeatService()
    mod.restartHeartbeatService()
    try {
      const status = mod.getHeartbeatServiceStatus()
      assert.equal(status.running, true)
      assert.equal(status.trackedSessions, 0)
    } finally {
      mod.stopHeartbeatService()
    }
  })

  it('double start replaces the timer (no duplicate intervals)', () => {
    mod.startHeartbeatService()
    mod.startHeartbeatService()
    try {
      const status = mod.getHeartbeatServiceStatus()
      assert.equal(status.running, true)
    } finally {
      mod.stopHeartbeatService()
    }
  })
})

// ── buildAgentHeartbeatPrompt ───────────────────────────────────────────

describe('buildAgentHeartbeatPrompt', () => {
  it('returns fallback prompt when agent is null', () => {
    const result = mod.buildAgentHeartbeatPrompt({ id: 's1' }, null, 'fallback', '')
    assert.equal(result, 'fallback')
  })

  it('includes AGENT_HEARTBEAT_TICK header', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      { id: 's1', messages: [] },
      { name: 'Bot' },
      'Check status',
      '',
    )
    assert.ok(result.includes('AGENT_HEARTBEAT_TICK'))
  })

  it('includes heartbeat file content when provided', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      { id: 's1', messages: [] },
      { name: 'Bot' },
      'Check status',
      '# Tasks\n- Do the thing',
    )
    assert.ok(result.includes('HEARTBEAT.md contents'))
    assert.ok(result.includes('Do the thing'))
  })

  it('excludes HEARTBEAT.md section when content is effectively empty', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      { id: 's1', messages: [] },
      { name: 'Bot' },
      'Check status',
      '# Title\n- [ ] ',
    )
    assert.ok(!result.includes('HEARTBEAT.md contents'))
  })

  it('includes dynamic goal when set on agent', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      { id: 's1', messages: [] },
      { name: 'Bot', heartbeatGoal: 'Monitor CI pipeline' },
      'Check status',
      '',
    )
    assert.ok(result.includes('Monitor CI pipeline'))
  })

  it('includes recent conversation context', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      {
        id: 's1',
        messages: [
          { role: 'user', text: 'Check the logs', toolEvents: [] },
          { role: 'assistant', text: 'Logs look clean', toolEvents: [] },
        ],
      },
      { name: 'Bot' },
      'Check status',
      '',
    )
    assert.ok(result.includes('[user]: Check the logs'))
    assert.ok(result.includes('[assistant]: Logs look clean'))
  })

  it('includes agent soul in prompt', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      { id: 's1', messages: [] },
      { name: 'Bot', soul: 'You are a cheerful monitoring assistant' },
      'Check status',
      '',
    )
    assert.ok(result.includes('Persona: You are a cheerful'))
  })

  it('strips blocked items from heartbeat file content', () => {
    const result = mod.buildAgentHeartbeatPrompt(
      { id: 's1', messages: [] },
      { name: 'Bot' },
      'Check status',
      '- Active task\n- Blocked task (blocked, waiting)\n- Another active task',
    )
    assert.ok(result.includes('Active task'))
    assert.ok(!result.includes('Blocked task'))
    assert.ok(result.includes('Another active task'))
  })
})

// ── lightContext config ─────────────────────────────────────────────────

describe('heartbeatConfigForSession lightContext', () => {
  it('defaults to false when not set', () => {
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1' },
      { heartbeatIntervalSec: 60 },
      {},
    )
    assert.equal(cfg.lightContext, false)
  })

  it('inherits from global settings', () => {
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1' },
      { heartbeatIntervalSec: 60, heartbeatLightContext: true },
      {},
    )
    assert.equal(cfg.lightContext, true)
  })

  it('agent overrides global', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatLightContext: true },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1' },
      { heartbeatIntervalSec: 60, heartbeatLightContext: false },
      agents,
    )
    assert.equal(cfg.lightContext, true)
  })

  it('agent false overrides global true', () => {
    const agents: Record<string, Record<string, unknown>> = {
      'a1': { heartbeatLightContext: false },
    }
    const cfg = mod.heartbeatConfigForSession(
      { id: 's1', agentId: 'a1' },
      { heartbeatIntervalSec: 60, heartbeatLightContext: true },
      agents,
    )
    assert.equal(cfg.lightContext, false)
  })
})
