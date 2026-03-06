import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  BROWSER_PROFILES_DIR: process.env.BROWSER_PROFILES_DIR,
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let browserState: typeof import('./browser-state')
let storage: typeof import('./storage')

function baseSession(id: string, extra: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id,
    name: id,
    cwd: process.cwd(),
    user: 'tester',
    provider: 'openai',
    model: 'gpt-test',
    claudeSessionId: null,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    ...extra,
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-browser-state-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.BROWSER_PROFILES_DIR = path.join(tempDir, 'browser-profiles')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  browserState = await import('./browser-state')
  storage = await import('./storage')
})

after(() => {
  if (originalEnv.BROWSER_PROFILES_DIR === undefined) delete process.env.BROWSER_PROFILES_DIR
  else process.env.BROWSER_PROFILES_DIR = originalEnv.BROWSER_PROFILES_DIR
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('browser-state', () => {
  it('defaults child sessions to their own browser profile id unless sharing is explicit', () => {
    storage.saveSessions({
      parent: baseSession('parent', { browserProfileId: 'shared-browser' }),
      child: baseSession('child', { parentSessionId: 'parent' }),
    })

    const resolved = browserState.ensureSessionBrowserProfileId('child')
    const sessions = storage.loadSessions()

    assert.equal(resolved.profileId, 'child')
    assert.equal(resolved.inheritedFromSessionId, null)
    assert.equal(sessions.child.browserProfileId, 'child')
  })

  it('persists browser observations and close state', () => {
    storage.saveSessions({
      solo: baseSession('solo'),
    })

    const profile = browserState.ensureSessionBrowserProfileId('solo')
    const profileDir = browserState.getBrowserProfileDir(profile.profileId)
    assert.equal(fs.existsSync(profileDir), true)

    browserState.upsertBrowserSessionRecord({
      sessionId: 'solo',
      profileId: profile.profileId,
      profileDir,
      status: 'active',
      lastAction: 'browser_open',
    })

    browserState.recordBrowserObservation('solo', {
      capturedAt: Date.now(),
      url: 'https://example.com',
      title: 'Example',
      textPreview: 'Example domain',
      links: [{ text: 'More information', href: 'https://iana.org/domains/example' }],
      forms: [],
      tables: [],
      errors: [],
    })

    const observed = browserState.loadBrowserSessionRecord('solo')
    assert.equal(observed?.currentUrl, 'https://example.com')
    assert.equal(observed?.pageTitle, 'Example')
    assert.equal(observed?.lastObservation?.links?.length, 1)

    const closed = browserState.markBrowserSessionClosed('solo', 'browser crashed')
    assert.equal(closed?.status, 'error')
    assert.equal(closed?.lastError, 'browser crashed')

    browserState.removeBrowserSessionRecord('solo')
    assert.equal(browserState.loadBrowserSessionRecord('solo'), null)
  })

  it('creates profile directories under the configured data dir', () => {
    const dir = browserState.getBrowserProfileDir('profile with spaces')
    assert.equal(fs.existsSync(dir), true)
    assert.equal(dir.startsWith(process.env.BROWSER_PROFILES_DIR!), true)
  })
})
