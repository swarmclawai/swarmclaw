'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  COMMANDS,
  extractPathParams,
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

test('Binary CLI router reaches every mapped API command pair', async () => {
  const { shouldUseLegacyTsCli, TS_CLI_ACTIONS } = await import('../../bin/swarmclaw.js')

  for (const command of COMMANDS) {
    if (command.virtual) continue

    const pathArgs = extractPathParams(command.route).map((name, index) => `${name}-${index + 1}`)
    const routedToLegacyTs = shouldUseLegacyTsCli([command.group, command.action, ...pathArgs])

    if (routedToLegacyTs) {
      assert.ok(
        TS_CLI_ACTIONS[command.group]?.has(command.action),
        `legacy TS router should only claim known actions (${command.group} ${command.action})`,
      )
    }
  }

  // Spot-check known API commands that are map-only today.
  assert.equal(shouldUseLegacyTsCli(['chatrooms', 'list']), false)
  assert.equal(shouldUseLegacyTsCli(['tasks', 'approve', 'task-1']), false)

  // Help paths should route to mapped CLI for full command discoverability.
  assert.equal(shouldUseLegacyTsCli([]), false)
  assert.equal(shouldUseLegacyTsCli(['--help']), false)
  assert.equal(shouldUseLegacyTsCli(['tasks', '--help']), false)

  // And a legacy command that should remain on the richer TS path.
  assert.equal(shouldUseLegacyTsCli(['tasks', 'create']), true)
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

test('openclaw deploy bundle command merges action with provided JSON body', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const calls = []

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true, bundle: { template: 'docker' } })
  }

  const exitCode = await runCli(
    ['openclaw', 'deploy-bundle', '--data', '{"template":"docker","target":"openclaw.example.com"}', '--json'],
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
  assert.match(calls[0].url, /\/api\/openclaw\/deploy$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    action: 'bundle',
    template: 'docker',
    target: 'openclaw.example.com',
  })
  assert.equal(stdout.toString().trim(), '{"ok":true,"bundle":{"template":"docker"}}')
  assert.equal(stderr.toString(), '')
})

test('openclaw deploy ssh command merges action with provided JSON body', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const calls = []

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true, processId: 'remote-1' })
  }

  const exitCode = await runCli(
    ['openclaw', 'deploy-ssh', '--data', '{"target":"openclaw.example.com","ssh":{"host":"1.2.3.4"}}', '--json'],
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
  assert.match(calls[0].url, /\/api\/openclaw\/deploy$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    action: 'ssh-deploy',
    target: 'openclaw.example.com',
    ssh: { host: '1.2.3.4' },
  })
  assert.equal(stdout.toString().trim(), '{"ok":true,"processId":"remote-1"}')
  assert.equal(stderr.toString(), '')
})

test('openclaw remote restore command merges action with provided JSON body', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const calls = []

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true, remote: { status: 'running' } })
  }

  const exitCode = await runCli(
    ['openclaw', 'remote-restore', '--data', '{"backupPath":"/opt/openclaw/backups/latest.tgz","ssh":{"host":"1.2.3.4"}}', '--json'],
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
  assert.match(calls[0].url, /\/api\/openclaw\/deploy$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    action: 'remote-restore',
    backupPath: '/opt/openclaw/backups/latest.tgz',
    ssh: { host: '1.2.3.4' },
  })
  assert.equal(stdout.toString().trim(), '{"ok":true,"remote":{"status":"running"}}')
  assert.equal(stderr.toString(), '')
})

test('runCli falls back to platform-api-key.txt when env key is missing', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const calls = []

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-cli-keyfile-'))
  fs.writeFileSync(path.join(tmpDir, 'platform-api-key.txt'), 'file-key\n', 'utf8')

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true })
  }

  const exitCode = await runCli(
    ['runs', 'list', '--json'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: tmpDir,
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(calls[0].init.headers['X-Access-Key'], 'file-key')
  assert.equal(stderr.toString(), '')

  fs.rmSync(tmpDir, { recursive: true, force: true })
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

test('binary responses require --out when stdout is a TTY', async () => {
  const stdout = makeWritable()
  stdout.isTTY = true
  const stderr = makeWritable()

  const fetchImpl = async () =>
    new Response(Buffer.from('hello'), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })

  const exitCode = await runCli(
    ['uploads', 'get', 'artifact.bin'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 1)
  assert.match(stderr.toString(), /binary response requires --out <file>/i)
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

test('runCli parses CRLF-delimited SSE events correctly', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()

  const fetchImpl = async () => new Response(
    'data: {"t":"md","text":"first"}\r\n\r\ndata: {"t":"md","text":"second"}\r\n\r\n',
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }
  )

  const exitCode = await runCli(
    ['chatrooms', 'chat', 'room-1', '--data', '{}'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(stdout.toString(), 'first\nsecond\n')
  assert.equal(stderr.toString(), '')
})

test('binary responses require --out when stdout is a TTY', async () => {
  const stdout = makeWritable()
  stdout.isTTY = true
  const stderr = makeWritable()

  const fetchImpl = async () => new Response(Buffer.from('ok'), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  })

  const exitCode = await runCli(
    ['memory-images', 'get', 'image-1.png'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 1)
  assert.equal(stdout.toString(), '')
  assert.match(stderr.toString(), /binary response requires --out <file>/i)
})

test('client-side collection lookups fail cleanly when the entity is missing', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()

  const fetchImpl = async () => jsonResponse([{ id: 'agent-2', name: 'Other Agent' }])

  const exitCode = await runCli(
    ['agents', 'get', 'agent-1'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    }
  )

  assert.equal(exitCode, 1)
  assert.equal(stdout.toString(), '')
  assert.match(stderr.toString(), /entity not found for id: agent-1/i)
})

test('runCli loads request JSON from @file inputs', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-cli-data-'))
  const dataPath = path.join(tmpDir, 'payload.json')
  fs.writeFileSync(dataPath, JSON.stringify({ title: 'From file', status: 'backlog' }), 'utf8')

  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true })
  }

  const exitCode = await runCli(
    ['tasks', 'create', '--data', `@${dataPath}`],
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
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'From file', status: 'backlog' })

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('runCli falls back to platform-api-key.txt when no env key is provided', async () => {
  const stdout = makeWritable()
  const stderr = makeWritable()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-cli-key-'))
  fs.writeFileSync(path.join(tmpDir, 'platform-api-key.txt'), 'file-key\n', 'utf8')

  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ ok: true })
  }

  const exitCode = await runCli(
    ['runs', 'list'],
    {
      fetchImpl,
      stdout,
      stderr,
      env: {},
      cwd: tmpDir,
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers['X-Access-Key'], 'file-key')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('all command definitions execute with a mocked API transport', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-cli-all-'))
  const uploadPath = path.join(tmpDir, 'upload.txt')
  fs.writeFileSync(uploadPath, 'upload payload', 'utf8')

  for (const command of COMMANDS) {
    const stdout = makeWritable()
    const stderr = makeWritable()
    const pathArgs = extractPathParams(command.route).map((name, index) => {
      if (name === 'filename') return `file-${index}.txt`
      return `${name}-${index + 1}`
    })

    const argv = [command.group, command.action, ...pathArgs]
    if (command.requestType === 'upload') {
      argv.push(uploadPath)
    }

    if (command.bodyFlagMap && Object.prototype.hasOwnProperty.call(command.bodyFlagMap, 'key')) {
      argv.push('--key', 'test-key')
    }
    if (command.bodyFlagMap && Object.prototype.hasOwnProperty.call(command.bodyFlagMap, 'text')) {
      argv.push('--text', 'hello from test')
    }

    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init })

      if (command.clientGetRoute) {
        const id = pathArgs[0]
        return jsonResponse([{ id }])
      }

      if (command.responseType === 'binary') {
        return new Response(Buffer.from('ok'), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })
      }

      if (command.responseType === 'sse') {
        return new Response('data: {"t":"md","text":"ok"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }

      return jsonResponse({ ok: true })
    }

    const exitCode = await runCli(argv, {
      fetchImpl,
      stdout,
      stderr,
      env: {
        SWARMCLAW_API_KEY: 'test-key',
      },
      cwd: process.cwd(),
    })

    assert.equal(exitCode, 0, `command failed: ${command.group} ${command.action}`)
    assert.equal(calls.length, 1, `expected one request for ${command.group} ${command.action}`)
    assert.equal(stderr.toString(), '', `unexpected stderr for ${command.group} ${command.action}`)

    if (command.requestType === 'upload') {
      assert.ok(Buffer.isBuffer(calls[0].init.body))
      assert.equal(calls[0].init.headers['x-filename'], 'upload.txt')
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
