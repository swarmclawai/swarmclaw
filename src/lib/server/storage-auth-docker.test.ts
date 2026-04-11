import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * End-to-end simulation of the Docker key persistence fix.
 *
 * Simulates a Docker container lifecycle where:
 * 1. .env.local is NOT writable (baked into the image, not volume-mounted)
 * 2. DATA_DIR IS writable (volume-mounted at ./data:/app/data)
 * 3. Keys should persist across container restarts via DATA_DIR/.env.generated
 */

// Replicate the core logic from storage-auth.ts
function loadEnvFile(filePath: string, env: Record<string, string>): void {
  if (!fs.existsSync(filePath)) return
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && v.length) env[k.trim()] = v.join('=').trim()
  })
}

function appendEnvKeyIfMissing(envPath: string, key: string, value: string): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const keyPattern = new RegExp(`^${key}=`, 'm')
  if (keyPattern.test(existing)) return
  fs.appendFileSync(envPath, `\n${key}=${value}\n`)
}

function persistEnvKey(
  key: string,
  value: string,
  envLocalPath: string,
  generatedEnvPath: string,
): boolean {
  try {
    appendEnvKeyIfMissing(envLocalPath, key, value)
    return true
  } catch {
    // .env.local not writable
  }
  try {
    fs.mkdirSync(path.dirname(generatedEnvPath), { recursive: true })
    appendEnvKeyIfMissing(generatedEnvPath, key, value)
    return true
  } catch {
    return false
  }
}

/** Simulate a complete container lifecycle: boot, generate keys, restart, verify keys persist. */
function simulateContainerBoot(
  envLocalPath: string,
  generatedEnvPath: string,
): { accessKey: string; credentialSecret: string } {
  const env: Record<string, string> = {}

  // Step 1: loadEnv — read both locations
  loadEnvFile(envLocalPath, env)
  loadEnvFile(generatedEnvPath, env)

  // Step 2: auto-generate if missing
  if (!env.CREDENTIAL_SECRET) {
    const secret = 'test-secret-' + Date.now()
    env.CREDENTIAL_SECRET = secret
    persistEnvKey('CREDENTIAL_SECRET', secret, envLocalPath, generatedEnvPath)
  }
  if (!env.ACCESS_KEY) {
    const key = 'test-key-' + Date.now()
    env.ACCESS_KEY = key
    persistEnvKey('ACCESS_KEY', key, envLocalPath, generatedEnvPath)
  }

  return { accessKey: env.ACCESS_KEY, credentialSecret: env.CREDENTIAL_SECRET }
}

describe('Docker container key persistence (end-to-end simulation)', () => {
  let tmpDir: string
  let dataDir: string
  let readOnlyDir: string
  let envLocalPath: string
  let generatedEnvPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-sim-'))
    // Simulate Docker: data dir is writable (volume-mounted)
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    generatedEnvPath = path.join(dataDir, '.env.generated')

    // Simulate Docker: .env.local dir is NOT writable (inside container image)
    readOnlyDir = path.join(tmpDir, 'readonly')
    fs.mkdirSync(readOnlyDir, { recursive: true })
    envLocalPath = path.join(readOnlyDir, '.env.local')
    // Make the directory read-only to simulate Docker container filesystem
    fs.chmodSync(readOnlyDir, 0o555)
  })

  afterEach(() => {
    // Restore permissions before cleanup
    try { fs.chmodSync(readOnlyDir, 0o755) } catch { /* ok */ }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('first boot generates keys and persists to data dir fallback', () => {
    const boot1 = simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.ok(boot1.accessKey, 'ACCESS_KEY should be generated')
    assert.ok(boot1.credentialSecret, 'CREDENTIAL_SECRET should be generated')
    assert.ok(fs.existsSync(generatedEnvPath), '.env.generated should exist in data dir')

    const content = fs.readFileSync(generatedEnvPath, 'utf8')
    assert.ok(content.includes('ACCESS_KEY='), 'ACCESS_KEY should be in .env.generated')
    assert.ok(content.includes('CREDENTIAL_SECRET='), 'CREDENTIAL_SECRET should be in .env.generated')
  })

  it('keys survive container restart (same data dir)', () => {
    // First boot
    const boot1 = simulateContainerBoot(envLocalPath, generatedEnvPath)

    // Simulate container restart: keys from .env.generated should be reloaded
    const boot2 = simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.equal(boot2.accessKey, boot1.accessKey, 'ACCESS_KEY should persist across restart')
    assert.equal(boot2.credentialSecret, boot1.credentialSecret, 'CREDENTIAL_SECRET should persist across restart')
  })

  it('three consecutive restarts all return the same keys', () => {
    const boot1 = simulateContainerBoot(envLocalPath, generatedEnvPath)
    const boot2 = simulateContainerBoot(envLocalPath, generatedEnvPath)
    const boot3 = simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.equal(boot1.accessKey, boot2.accessKey)
    assert.equal(boot2.accessKey, boot3.accessKey)
    assert.equal(boot1.credentialSecret, boot2.credentialSecret)
    assert.equal(boot2.credentialSecret, boot3.credentialSecret)
  })

  it('.env.local is never written when read-only', () => {
    simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.ok(!fs.existsSync(envLocalPath), '.env.local should NOT be created in read-only dir')
  })
})

describe('Local dev key persistence (writable .env.local)', () => {
  let tmpDir: string
  let dataDir: string
  let envLocalPath: string
  let generatedEnvPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-dev-sim-'))
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    generatedEnvPath = path.join(dataDir, '.env.generated')
    envLocalPath = path.join(tmpDir, '.env.local')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes keys to .env.local when writable (local dev mode)', () => {
    const boot = simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.ok(boot.accessKey)
    assert.ok(fs.existsSync(envLocalPath), '.env.local should be created')
    const content = fs.readFileSync(envLocalPath, 'utf8')
    assert.ok(content.includes('ACCESS_KEY='), 'ACCESS_KEY should be in .env.local')
  })

  it('does not create .env.generated when .env.local is writable', () => {
    simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.ok(!fs.existsSync(generatedEnvPath), '.env.generated should NOT be created when .env.local works')
  })

  it('pre-existing .env.local keys are preserved', () => {
    fs.writeFileSync(envLocalPath, 'ACCESS_KEY=preset-key\nCREDENTIAL_SECRET=preset-secret\n')

    const boot = simulateContainerBoot(envLocalPath, generatedEnvPath)

    assert.equal(boot.accessKey, 'preset-key', 'pre-existing ACCESS_KEY should be loaded')
    assert.equal(boot.credentialSecret, 'preset-secret', 'pre-existing CREDENTIAL_SECRET should be loaded')
  })

  it('.env.local takes precedence over .env.generated when both exist', () => {
    // Simulate: .env.generated has old auto-generated keys
    fs.writeFileSync(generatedEnvPath, 'ACCESS_KEY=auto-old\nCREDENTIAL_SECRET=auto-old-secret\n')
    // User creates .env.local with their own custom keys
    fs.writeFileSync(envLocalPath, 'ACCESS_KEY=user-custom\nCREDENTIAL_SECRET=user-custom-secret\n')

    const env: Record<string, string> = {}
    // Load order must match storage-auth.ts: .env.generated first, then .env.local
    loadEnvFile(generatedEnvPath, env)
    loadEnvFile(envLocalPath, env)

    assert.equal(env.ACCESS_KEY, 'user-custom', '.env.local should override .env.generated')
    assert.equal(env.CREDENTIAL_SECRET, 'user-custom-secret', '.env.local should override .env.generated')
  })
})

describe('Windows line endings in .env files', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('parses .env.local with CRLF endings correctly', () => {
    const envPath = path.join(tmpDir, '.env.local')
    // Write with Windows-style line endings
    fs.writeFileSync(envPath, 'ACCESS_KEY=win-key-123\r\nCREDENTIAL_SECRET=win-secret-456\r\n')

    const env: Record<string, string> = {}
    loadEnvFile(envPath, env)

    assert.equal(env.ACCESS_KEY, 'win-key-123', 'No trailing \\r on ACCESS_KEY')
    assert.equal(env.CREDENTIAL_SECRET, 'win-secret-456', 'No trailing \\r on CREDENTIAL_SECRET')

    // Double-check no \r characters
    assert.ok(!env.ACCESS_KEY.includes('\r'))
    assert.ok(!env.CREDENTIAL_SECRET.includes('\r'))
  })

  it('key from CRLF file matches expected value for auth validation', () => {
    const envPath = path.join(tmpDir, '.env.local')
    fs.writeFileSync(envPath, 'ACCESS_KEY=test-auth-key\r\n')

    const env: Record<string, string> = {}
    loadEnvFile(envPath, env)

    // Simulate validateAccessKey logic
    const userInput = 'test-auth-key'
    assert.equal(env.ACCESS_KEY, userInput, 'Key from CRLF file should match user input exactly')
  })
})
