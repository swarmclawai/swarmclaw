import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Tests for storage-auth helpers.
 *
 * We can't import the module directly (it has side-effects that touch the real
 * filesystem), so we test the key parsing and persistence logic in isolation
 * by reimplementing the pure functions and verifying the patterns they use.
 */

// Replicate the env-file parser from storage-auth.ts
function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {}
  content.split(/\r?\n/).forEach((line) => {
    const [k, ...v] = line.split('=')
    if (k && v.length) vars[k.trim()] = v.join('=').trim()
  })
  return vars
}

// Replicate appendEnvKeyIfMissing from storage-auth.ts
function appendEnvKeyIfMissing(envPath: string, key: string, value: string): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const keyPattern = new RegExp(`^${key}=`, 'm')
  if (keyPattern.test(existing)) return
  fs.appendFileSync(envPath, `\n${key}=${value}\n`)
}

describe('env file parsing', () => {
  it('parses Unix line endings', () => {
    const vars = parseEnvFile('ACCESS_KEY=abc123\nCREDENTIAL_SECRET=secret456\n')
    assert.equal(vars.ACCESS_KEY, 'abc123')
    assert.equal(vars.CREDENTIAL_SECRET, 'secret456')
  })

  it('parses Windows line endings without trailing \\r', () => {
    const vars = parseEnvFile('ACCESS_KEY=abc123\r\nCREDENTIAL_SECRET=secret456\r\n')
    assert.equal(vars.ACCESS_KEY, 'abc123')
    assert.equal(vars.CREDENTIAL_SECRET, 'secret456')
    // Verify no \r is left on the values
    assert.ok(!vars.ACCESS_KEY.includes('\r'), 'ACCESS_KEY should not contain \\r')
    assert.ok(!vars.CREDENTIAL_SECRET.includes('\r'), 'CREDENTIAL_SECRET should not contain \\r')
  })

  it('handles mixed line endings', () => {
    const vars = parseEnvFile('A=1\r\nB=2\nC=3\r\n')
    assert.equal(vars.A, '1')
    assert.equal(vars.B, '2')
    assert.equal(vars.C, '3')
  })

  it('preserves values containing equals signs', () => {
    const vars = parseEnvFile('SECRET=abc=def=ghi\n')
    assert.equal(vars.SECRET, 'abc=def=ghi')
  })

  it('skips empty lines and comment-like lines without =', () => {
    const vars = parseEnvFile('\n# comment line\nKEY=val\n\n')
    assert.equal(Object.keys(vars).length, 1)
    assert.equal(vars.KEY, 'val')
  })

  it('trims whitespace from keys and values', () => {
    const vars = parseEnvFile('  MY_KEY  =  my_value  \n')
    assert.equal(vars.MY_KEY, 'my_value')
  })
})

describe('appendEnvKeyIfMissing', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-auth-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appends key to empty file', () => {
    const envPath = path.join(tmpDir, '.env.local')
    fs.writeFileSync(envPath, '', 'utf8')
    appendEnvKeyIfMissing(envPath, 'ACCESS_KEY', 'test123')
    const content = fs.readFileSync(envPath, 'utf8')
    assert.ok(content.includes('ACCESS_KEY=test123'))
  })

  it('creates file if it does not exist', () => {
    const envPath = path.join(tmpDir, '.env.local')
    appendEnvKeyIfMissing(envPath, 'ACCESS_KEY', 'test123')
    assert.ok(fs.existsSync(envPath))
    const content = fs.readFileSync(envPath, 'utf8')
    assert.ok(content.includes('ACCESS_KEY=test123'))
  })

  it('does not duplicate an existing key', () => {
    const envPath = path.join(tmpDir, '.env.local')
    fs.writeFileSync(envPath, 'ACCESS_KEY=original\n', 'utf8')
    appendEnvKeyIfMissing(envPath, 'ACCESS_KEY', 'should-not-appear')
    const content = fs.readFileSync(envPath, 'utf8')
    assert.equal(content, 'ACCESS_KEY=original\n')
  })

  it('appends a second key without overwriting the first', () => {
    const envPath = path.join(tmpDir, '.env.local')
    fs.writeFileSync(envPath, 'FIRST=1\n', 'utf8')
    appendEnvKeyIfMissing(envPath, 'SECOND', '2')
    const vars = parseEnvFile(fs.readFileSync(envPath, 'utf8'))
    assert.equal(vars.FIRST, '1')
    assert.equal(vars.SECOND, '2')
  })
})

describe('Docker key persistence fallback', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-auth-docker-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keys written to fallback file survive simulated container restart', () => {
    // Simulate: write keys to a "data dir" fallback (like DATA_DIR/.env.generated)
    const generatedEnvPath = path.join(tmpDir, '.env.generated')
    appendEnvKeyIfMissing(generatedEnvPath, 'ACCESS_KEY', 'docker-key-123')
    appendEnvKeyIfMissing(generatedEnvPath, 'CREDENTIAL_SECRET', 'docker-secret-456')

    // Simulate restart: re-read the file (as loadEnvFile would)
    const vars = parseEnvFile(fs.readFileSync(generatedEnvPath, 'utf8'))
    assert.equal(vars.ACCESS_KEY, 'docker-key-123')
    assert.equal(vars.CREDENTIAL_SECRET, 'docker-secret-456')
  })

  it('fallback file does not overwrite keys that already exist', () => {
    const generatedEnvPath = path.join(tmpDir, '.env.generated')
    appendEnvKeyIfMissing(generatedEnvPath, 'ACCESS_KEY', 'original')

    // Second call should not overwrite
    appendEnvKeyIfMissing(generatedEnvPath, 'ACCESS_KEY', 'new-value')
    const vars = parseEnvFile(fs.readFileSync(generatedEnvPath, 'utf8'))
    assert.equal(vars.ACCESS_KEY, 'original')
  })
})
