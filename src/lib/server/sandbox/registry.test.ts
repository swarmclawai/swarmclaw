import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

test('sandbox registry persists shell and browser entries', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-sandbox-registry-'))
  t.after(() => {
    if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalEnv.DATA_DIR
    if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
    else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.SWARMCLAW_BUILD_MODE = '1'

  const registry = await import('@/lib/server/sandbox/registry')

  await registry.upsertSandboxRegistryEntry({
    containerName: 'swarmclaw-sb-session-a',
    scopeKey: 'session:a',
    createdAtMs: 1,
    lastUsedAtMs: 2,
    image: 'node:22-slim',
    configHash: 'shell-hash',
  })
  await registry.upsertSandboxBrowserRegistryEntry({
    containerName: 'swarmclaw-sb-browser-a',
    scopeKey: 'session:a',
    createdAtMs: 3,
    lastUsedAtMs: 4,
    image: 'swarmclaw-sandbox-browser:bookworm-slim',
    configHash: 'browser-hash',
    cdpPort: 44001,
  })

  const shell = await registry.readSandboxRegistry()
  const browser = await registry.readSandboxBrowserRegistry()

  assert.equal(shell.entries.length, 1)
  assert.equal(shell.entries[0].configHash, 'shell-hash')
  assert.equal(browser.entries.length, 1)
  assert.equal(browser.entries[0].cdpPort, 44001)
})
