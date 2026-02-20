'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  getApiCoveragePairs,
  parseArgv,
  runCli,
} = require('./index')

function collectApiRoutePairs() {
  const root = path.join(process.cwd(), 'src', 'app', 'api')
  const files = []

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name === 'route.ts') files.push(full)
    }
  }

  walk(root)

  const pairs = new Set()
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, 'utf8')
    const rel = filePath
      .replace(path.join(process.cwd(), 'src', 'app', 'api'), '')
      .replace(/\\/g, '/')
      .replace(/\/route\.ts$/, '')
    const route = (rel || '/').replace(/\[(.+?)\]/g, ':$1')

    const methods = [...text.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)]
      .map((match) => match[1])

    for (const method of methods) {
      pairs.add(`${method} ${route}`)
    }
  }

  return pairs
}

function makeWritable() {
  return {
    chunks: [],
    isTTY: false,
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      return true
    },
    toString() {
      return this.chunks.join('')
    },
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

test('CLI command map covers all API route method/path pairs', () => {
  const routePairs = collectApiRoutePairs()
  const commandPairs = new Set(getApiCoveragePairs())

  const missing = [...routePairs].filter((pair) => !commandPairs.has(pair)).sort()
  assert.deepEqual(missing, [])
})

test('parseArgv parses group/action/options', () => {
  const parsed = parseArgv([
    'runs',
    'list',
    '--query',
    'sessionId=abc123',
    '--query=limit=25',
    '--base-url',
    'http://localhost:3456',
    '--json',
    '--wait',
  ])

  assert.equal(parsed.group, 'runs')
  assert.equal(parsed.action, 'list')
  assert.deepEqual(parsed.opts.query, ['sessionId=abc123', 'limit=25'])
  assert.equal(parsed.opts.baseUrl, 'http://localhost:3456')
  assert.equal(parsed.opts.jsonOutput, true)
  assert.equal(parsed.opts.wait, true)
})

test('runCli sends authenticated request and emits compact JSON when --json is set', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const calls = []

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true })
  }

  const exitCode = await runCli(
    ['runs', 'list', '--query', 'sessionId=main-wayde', '--json'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {
        SWARMCLAW_API_KEY: 'test-key',
      },
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/runs\?sessionId=main-wayde$/)
  assert.equal(calls[0].init.headers['X-Access-Key'], 'test-key')
  assert.equal(stdout.toString().trim(), '{"ok":true}')
  assert.equal(stderr.toString(), '')
})

test('upload command sends binary body and x-filename header', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-cli-'))
  const filePath = path.join(tmpDir, 'sample.txt')
  fs.writeFileSync(filePath, 'hello upload', 'utf8')

  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true, url: '/api/uploads/example.txt' })
  }

  const exitCode = await runCli(
    ['upload', 'file', filePath],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/upload$/)
  assert.ok(Buffer.isBuffer(calls[0].init.body))
  assert.equal(calls[0].init.headers['x-filename'], 'sample.txt')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('wait polls run endpoint until terminal state', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  let runPollCount = 0

  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/api/webhooks/hook-1')) {
      return jsonResponse({ ok: true, runId: 'run_1' })
    }
    if (u.endsWith('/api/runs/run_1')) {
      runPollCount += 1
      if (runPollCount < 2) {
        return jsonResponse({ id: 'run_1', status: 'queued' })
      }
      return jsonResponse({ id: 'run_1', status: 'completed' })
    }
    return jsonResponse({ error: 'unexpected url', url: u }, 500)
  }

  const exitCode = await runCli(
    ['webhooks', 'trigger', 'hook-1', '--data', '{}', '--wait', '--interval-ms', '1', '--timeout-ms', '2000'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 0)
  assert.ok(runPollCount >= 2)
  assert.equal(stderr.toString(), '')
  assert.match(stdout.toString(), /"runId": "run_1"/)
  assert.match(stdout.toString(), /\[wait\] run run_1: queued/)
  assert.match(stdout.toString(), /"status": "completed"/)
})
