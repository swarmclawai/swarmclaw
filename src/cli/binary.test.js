'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildLegacyTsCliArgs } = require('../../bin/swarmclaw.js')

const CLI_BIN = path.join(__dirname, '..', '..', 'bin', 'swarmclaw.js')
const PACKAGE_JSON = require('../../package.json')
const APP_ROOT = path.join(__dirname, '..', '..')

function runBinary(args, options = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: options.cwd || APP_ROOT,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: 'utf8',
  })
}

function runWithMockedFetch(args, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-binary-fetch-'))
  const capturePath = path.join(tmpDir, 'capture.json')
  const preloadPath = path.join(tmpDir, 'mock-fetch.cjs')

  fs.writeFileSync(
    preloadPath,
    `
const fs = require('node:fs')
globalThis.fetch = async (url, init = {}) => {
  const capture = {
    url: String(url),
    method: init.method || 'GET',
    headers: init.headers || {},
    body: typeof init.body === 'string'
      ? init.body
      : (Buffer.isBuffer(init.body) ? init.body.toString('utf8') : null),
  }
  fs.writeFileSync(process.env.SWARMCLAW_TEST_CAPTURE, JSON.stringify(capture), 'utf8')
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
`,
    'utf8',
  )

  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
    .filter(Boolean)
    .join(' ')

  const result = runBinary(args, {
    ...options,
    env: {
      ...options.env,
      NODE_OPTIONS: nodeOptions,
      SWARMCLAW_TEST_CAPTURE: capturePath,
    },
  })

  const capture = fs.existsSync(capturePath)
    ? JSON.parse(fs.readFileSync(capturePath, 'utf8'))
    : null

  fs.rmSync(tmpDir, { recursive: true, force: true })
  return { result, capture }
}

test('legacy-routed binary commands honor SWARMCLAW_API_KEY', () => {
  const { result, capture } = runWithMockedFetch(
    ['runs', 'list', '--raw', '--url', 'http://localhost:3456'],
    {
      env: {
        SWARMCLAW_API_KEY: 'legacy-api-key',
        SWARMCLAW_ACCESS_KEY: '',
        SC_ACCESS_KEY: '',
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '[]')
  assert.equal(capture.headers['X-Access-Key'], 'legacy-api-key')
})

test('legacy-routed binary commands fall back to platform-api-key.txt', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-binary-keyfile-'))
  fs.writeFileSync(path.join(tmpDir, 'platform-api-key.txt'), 'file-fallback-key\n', 'utf8')

  const { result, capture } = runWithMockedFetch(
    ['runs', 'list', '--raw', '--url', 'http://localhost:3456'],
    {
      cwd: tmpDir,
      env: {
        SWARMCLAW_API_KEY: '',
        SWARMCLAW_ACCESS_KEY: '',
        SC_ACCESS_KEY: '',
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '[]')
  assert.equal(capture.headers['X-Access-Key'], 'file-fallback-key')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('binary server help exits successfully', () => {
  const result = runBinary(['server', '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: swarmclaw server/i)
})

test('binary update help exits successfully', () => {
  const result = runBinary(['update', '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage: swarmclaw update/i)
})

test('binary version output matches package version', () => {
  const result = runBinary(['--version'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), `${PACKAGE_JSON.name} ${PACKAGE_JSON.version}`)
})

test('legacy TS launcher falls back to tsx import when strip-types is unavailable', () => {
  const cliPath = path.join(APP_ROOT, 'src', 'cli', 'index.ts')
  const args = buildLegacyTsCliArgs(cliPath, ['runs', 'list'], {
    supportsStripTypes: false,
    hasTsxRuntime: true,
  })

  assert.deepEqual(args, ['--no-warnings', '--import', 'tsx', cliPath, 'runs', 'list'])
})
