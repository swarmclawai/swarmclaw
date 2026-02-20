'use strict'

const fs = require('fs')
const path = require('path')

function cmd(name, method, routePath, description, extra = {}) {
  return {
    name,
    method,
    path: routePath,
    description,
    ...extra,
  }
}

const COMMAND_GROUPS = [
  {
    name: 'agents',
    description: 'Manage agents',
    commands: [
      cmd('list', 'GET', '/agents', 'List agents'),
      cmd('create', 'POST', '/agents', 'Create an agent'),
      cmd('update', 'PUT', '/agents/:id', 'Update an agent by ID'),
      cmd('delete', 'DELETE', '/agents/:id', 'Delete an agent by ID'),
      cmd('generate', 'POST', '/agents/generate', 'Generate an agent definition from prompt', { requiresBody: true }),
    ],
  },
  {
    name: 'auth',
    description: 'Access key auth endpoints',
    commands: [
      cmd('status', 'GET', '/auth', 'Show auth/setup status'),
      cmd('login', 'POST', '/auth', 'Validate access key', {
        requiresBody: true,
        bodyFlagMap: { key: 'key' },
      }),
    ],
  },
  {
    name: 'claude-skills',
    description: 'Inspect local Claude skills',
    commands: [
      cmd('list', 'GET', '/claude-skills', 'List discovered Claude skills'),
    ],
  },
  {
    name: 'connectors',
    description: 'Manage platform connectors',
    commands: [
      cmd('list', 'GET', '/connectors', 'List connectors'),
      cmd('get', 'GET', '/connectors/:id', 'Get connector by ID'),
      cmd('create', 'POST', '/connectors', 'Create connector'),
      cmd('update', 'PUT', '/connectors/:id', 'Update connector by ID'),
      cmd('delete', 'DELETE', '/connectors/:id', 'Delete connector by ID'),
      cmd('start', 'PUT', '/connectors/:id', 'Start connector', { defaultBody: { action: 'start' } }),
      cmd('stop', 'PUT', '/connectors/:id', 'Stop connector', { defaultBody: { action: 'stop' } }),
      cmd('repair', 'PUT', '/connectors/:id', 'Repair connector', { defaultBody: { action: 'repair' } }),
    ],
  },
  {
    name: 'credentials',
    description: 'Manage API credentials',
    commands: [
      cmd('list', 'GET', '/credentials', 'List credentials'),
      cmd('create', 'POST', '/credentials', 'Create credential', { requiresBody: true }),
      cmd('delete', 'DELETE', '/credentials/:id', 'Delete credential by ID'),
    ],
  },
  {
    name: 'daemon',
    description: 'Control daemon runtime',
    commands: [
      cmd('status', 'GET', '/daemon', 'Get daemon status'),
      cmd('action', 'POST', '/daemon', 'Set daemon action with --data {"action":"start|stop"}'),
      cmd('start', 'POST', '/daemon', 'Start daemon', { defaultBody: { action: 'start' } }),
      cmd('stop', 'POST', '/daemon', 'Stop daemon', { defaultBody: { action: 'stop' } }),
    ],
  },
  {
    name: 'dirs',
    description: 'Directory listing and picker endpoints',
    commands: [
      cmd('list', 'GET', '/dirs', 'List directories (use --query path=/some/path)'),
      cmd('pick', 'POST', '/dirs/pick', 'Invoke OS picker (use --data {"mode":"file|folder"})'),
    ],
  },
  {
    name: 'documents',
    description: 'Upload and fetch files',
    commands: [
      cmd('create', 'POST', '/upload', 'Upload a file', {
        requestType: 'upload',
        inputPositional: 'filePath',
      }),
      cmd('get', 'GET', '/uploads/:filename', 'Fetch uploaded file content', {
        responseType: 'binary',
      }),
    ],
  },
  {
    name: 'generate',
    description: 'AI generation endpoints',
    commands: [
      cmd('run', 'POST', '/generate', 'Generate schedule/task/skill/provider definitions', { requiresBody: true }),
      cmd('info', 'GET', '/generate/info', 'Get generate endpoint provider/model info'),
    ],
  },
  {
    name: 'ip',
    description: 'Inspect local server IP info',
    commands: [
      cmd('get', 'GET', '/ip', 'Get server IP and port'),
    ],
  },
  {
    name: 'logs',
    description: 'Read or clear app logs',
    commands: [
      cmd('list', 'GET', '/logs', 'List logs (use --query lines=200 --query level=INFO)'),
      cmd('clear', 'DELETE', '/logs', 'Clear logs'),
    ],
  },
  {
    name: 'memory',
    description: 'Manage memory entries',
    commands: [
      cmd('list', 'GET', '/memory', 'List/search memory entries'),
      cmd('create', 'POST', '/memory', 'Create memory entry'),
      cmd('update', 'PUT', '/memory/:id', 'Update memory entry by ID'),
      cmd('delete', 'DELETE', '/memory/:id', 'Delete memory entry by ID'),
    ],
  },
  {
    name: 'orchestrator',
    description: 'Run orchestrator tasks',
    commands: [
      cmd('run', 'POST', '/orchestrator/run', 'Queue orchestrator task', { requiresBody: true }),
    ],
  },
  {
    name: 'plugins',
    description: 'Manage plugin registry and installation',
    commands: [
      cmd('list', 'GET', '/plugins', 'List installed plugins'),
      cmd('set', 'POST', '/plugins', 'Enable/disable plugin', { requiresBody: true }),
      cmd('install', 'POST', '/plugins/install', 'Install plugin from HTTPS URL', { requiresBody: true }),
      cmd('marketplace', 'GET', '/plugins/marketplace', 'Fetch plugin marketplace registry'),
    ],
  },
  {
    name: 'providers',
    description: 'Manage providers and model overrides',
    commands: [
      cmd('list', 'GET', '/providers', 'List providers'),
      cmd('create', 'POST', '/providers', 'Create custom provider'),
      cmd('get', 'GET', '/providers/:id', 'Get provider by ID'),
      cmd('update', 'PUT', '/providers/:id', 'Update provider by ID'),
      cmd('delete', 'DELETE', '/providers/:id', 'Delete provider by ID'),
      cmd('configs', 'GET', '/providers/configs', 'List provider configs'),
      cmd('ollama', 'GET', '/providers/ollama', 'List Ollama models (use --query endpoint=http://localhost:11434)'),
      cmd('models', 'GET', '/providers/:id/models', 'Get provider model overrides'),
      cmd('models-set', 'PUT', '/providers/:id/models', 'Set provider model overrides'),
      cmd('models-clear', 'DELETE', '/providers/:id/models', 'Clear provider model overrides'),
    ],
  },
  {
    name: 'runs',
    description: 'Inspect session runs',
    commands: [
      cmd('list', 'GET', '/runs', 'List runs (use --query sessionId=... --query status=... --query limit=...)'),
      cmd('get', 'GET', '/runs/:id', 'Get run by ID'),
    ],
  },
  {
    name: 'schedules',
    description: 'Manage schedules',
    commands: [
      cmd('list', 'GET', '/schedules', 'List schedules'),
      cmd('create', 'POST', '/schedules', 'Create schedule'),
      cmd('update', 'PUT', '/schedules/:id', 'Update schedule by ID'),
      cmd('delete', 'DELETE', '/schedules/:id', 'Delete schedule by ID'),
      cmd('run', 'POST', '/schedules/:id/run', 'Run schedule immediately'),
    ],
  },
  {
    name: 'secrets',
    description: 'Manage secrets',
    commands: [
      cmd('list', 'GET', '/secrets', 'List secret metadata'),
      cmd('create', 'POST', '/secrets', 'Create secret', { requiresBody: true }),
      cmd('update', 'PUT', '/secrets/:id', 'Update secret metadata by ID'),
      cmd('delete', 'DELETE', '/secrets/:id', 'Delete secret by ID'),
    ],
  },
  {
    name: 'sessions',
    description: 'Manage sessions and session actions',
    commands: [
      cmd('list', 'GET', '/sessions', 'List sessions'),
      cmd('create', 'POST', '/sessions', 'Create session'),
      cmd('delete-many', 'DELETE', '/sessions', 'Delete many sessions via {"ids":[...]}', { requiresBody: true }),
      cmd('update', 'PUT', '/sessions/:id', 'Update session by ID'),
      cmd('delete', 'DELETE', '/sessions/:id', 'Delete session by ID'),
      cmd('messages', 'GET', '/sessions/:id/messages', 'List session messages'),
      cmd('chat', 'POST', '/sessions/:id/chat', 'Send chat message (SSE stream)', {
        requiresBody: true,
        streamResponse: true,
      }),
      cmd('stop', 'POST', '/sessions/:id/stop', 'Stop session run/processes'),
      cmd('clear', 'POST', '/sessions/:id/clear', 'Clear session messages'),
      cmd('deploy', 'POST', '/sessions/:id/deploy', 'Deploy session git repo', { requiresBody: true }),
      cmd('devserver', 'POST', '/sessions/:id/devserver', 'Session dev server action (requires --data {"action":"start|stop|status"})', { requiresBody: true }),
      cmd('devserver-start', 'POST', '/sessions/:id/devserver', 'Start session dev server', { defaultBody: { action: 'start' } }),
      cmd('devserver-stop', 'POST', '/sessions/:id/devserver', 'Stop session dev server', { defaultBody: { action: 'stop' } }),
      cmd('devserver-status', 'POST', '/sessions/:id/devserver', 'Get session dev server status', { defaultBody: { action: 'status' } }),
      cmd('browser-status', 'GET', '/sessions/:id/browser', 'Get browser status for session'),
      cmd('browser-close', 'DELETE', '/sessions/:id/browser', 'Close browser for session'),
    ],
  },
  {
    name: 'settings',
    description: 'Read and update settings',
    commands: [
      cmd('get', 'GET', '/settings', 'Get settings'),
      cmd('update', 'PUT', '/settings', 'Update settings'),
    ],
  },
  {
    name: 'skills',
    description: 'Manage skills',
    commands: [
      cmd('list', 'GET', '/skills', 'List skills'),
      cmd('get', 'GET', '/skills/:id', 'Get skill by ID'),
      cmd('create', 'POST', '/skills', 'Create skill'),
      cmd('update', 'PUT', '/skills/:id', 'Update skill by ID'),
      cmd('delete', 'DELETE', '/skills/:id', 'Delete skill by ID'),
      cmd('import', 'POST', '/skills/import', 'Import skill from URL', { requiresBody: true }),
    ],
  },
  {
    name: 'tasks',
    description: 'Manage tasks',
    commands: [
      cmd('list', 'GET', '/tasks', 'List tasks'),
      cmd('get', 'GET', '/tasks/:id', 'Get task by ID'),
      cmd('create', 'POST', '/tasks', 'Create task'),
      cmd('update', 'PUT', '/tasks/:id', 'Update task by ID'),
      cmd('delete', 'DELETE', '/tasks/:id', 'Delete task by ID'),
    ],
  },
  {
    name: 'tts',
    description: 'Text-to-speech endpoint',
    commands: [
      cmd('speak', 'POST', '/tts', 'Generate speech audio', {
        requiresBody: true,
        bodyFlagMap: { text: 'text' },
        responseType: 'binary',
      }),
    ],
  },
  {
    name: 'usage',
    description: 'Usage reports',
    commands: [
      cmd('get', 'GET', '/usage', 'Get usage summary'),
    ],
  },
  {
    name: 'version',
    description: 'Version and updater endpoints',
    commands: [
      cmd('get', 'GET', '/version', 'Get local/remote git version state'),
      cmd('update', 'POST', '/version/update', 'Pull latest changes'),
    ],
  },
  {
    name: 'webhooks',
    description: 'Trigger inbound webhook endpoint',
    commands: [
      cmd('trigger', 'POST', '/webhooks/:id', 'Trigger webhook by ID'),
    ],
  },
]

const GROUP_ALIASES = {
  memories: 'memory',
  uploads: 'documents',
  upload: 'documents',
  docs: 'documents',
}

const COMMANDS = []
const GROUP_INDEX = new Map()
const COMMAND_INDEX = new Map()

for (const group of COMMAND_GROUPS) {
  GROUP_INDEX.set(group.name, group)
  for (const command of group.commands) {
    const full = { ...command, group: group.name }
    COMMANDS.push(full)
    COMMAND_INDEX.set(`${group.name}:${command.name}`, full)
  }
}

const TERMINAL_RUN_STATUS = new Set(['completed', 'failed', 'cancelled'])
const TERMINAL_TASK_STATUS = new Set(['completed', 'failed'])

function normalizeGroupName(input) {
  return GROUP_ALIASES[input] || input
}

function parseArgv(argv) {
  const out = {
    positionals: [],
    flags: {
      help: false,
      version: false,
      json: false,
      raw: false,
      wait: false,
      stream: false,
      baseUrl: null,
      accessKey: null,
      key: null,
      data: null,
      query: [],
      header: [],
      out: null,
      file: null,
      filename: null,
      secret: null,
      event: null,
      text: null,
      waitIntervalMs: 1000,
      waitTimeoutMs: 300000,
    },
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]

    if (token === '--') {
      out.positionals.push(...argv.slice(i + 1))
      break
    }

    if (token === '-h' || token === '--help') {
      out.flags.help = true
      continue
    }

    if (token === '-v' || token === '--version') {
      out.flags.version = true
      continue
    }

    if (token === '--json') {
      out.flags.json = true
      continue
    }

    if (token === '--raw') {
      out.flags.raw = true
      continue
    }

    if (token === '--wait') {
      out.flags.wait = true
      continue
    }

    if (token === '--stream') {
      out.flags.stream = true
      continue
    }

    if (token.startsWith('--')) {
      const [name, inlineValue] = splitOption(token)
      const value = inlineValue === null ? argv[i + 1] : inlineValue

      const consumeNext = inlineValue === null

      switch (name) {
        case 'base-url':
          ensureValue(name, value)
          out.flags.baseUrl = value
          if (consumeNext) i += 1
          continue
        case 'access-key':
        case 'api-key':
          ensureValue(name, value)
          out.flags.accessKey = value
          if (consumeNext) i += 1
          continue
        case 'key':
          ensureValue(name, value)
          out.flags.key = value
          if (consumeNext) i += 1
          continue
        case 'data':
        case 'body':
          ensureValue(name, value)
          out.flags.data = value
          if (consumeNext) i += 1
          continue
        case 'query':
          ensureValue(name, value)
          out.flags.query.push(value)
          if (consumeNext) i += 1
          continue
        case 'header':
          ensureValue(name, value)
          out.flags.header.push(value)
          if (consumeNext) i += 1
          continue
        case 'out':
          ensureValue(name, value)
          out.flags.out = value
          if (consumeNext) i += 1
          continue
        case 'file':
          ensureValue(name, value)
          out.flags.file = value
          if (consumeNext) i += 1
          continue
        case 'filename':
          ensureValue(name, value)
          out.flags.filename = value
          if (consumeNext) i += 1
          continue
        case 'secret':
          ensureValue(name, value)
          out.flags.secret = value
          if (consumeNext) i += 1
          continue
        case 'event':
          ensureValue(name, value)
          out.flags.event = value
          if (consumeNext) i += 1
          continue
        case 'text':
          ensureValue(name, value)
          out.flags.text = value
          if (consumeNext) i += 1
          continue
        case 'wait-interval': {
          ensureValue(name, value)
          const n = Number.parseInt(value, 10)
          if (!Number.isFinite(n) || n < 1) {
            throw new Error('--wait-interval must be a positive integer in milliseconds')
          }
          out.flags.waitIntervalMs = n
          if (consumeNext) i += 1
          continue
        }
        case 'wait-timeout': {
          ensureValue(name, value)
          const n = Number.parseInt(value, 10)
          if (!Number.isFinite(n) || n < 1) {
            throw new Error('--wait-timeout must be a positive integer in milliseconds')
          }
          out.flags.waitTimeoutMs = n
          if (consumeNext) i += 1
          continue
        }
        default:
          throw new Error(`Unknown option: --${name}`)
      }
    }

    out.positionals.push(token)
  }

  return out
}

function splitOption(token) {
  const idx = token.indexOf('=')
  if (idx === -1) {
    return [token.slice(2), null]
  }
  return [token.slice(2, idx), token.slice(idx + 1)]
}

function ensureValue(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing value for --${name}`)
  }
}

function extractPathParamNames(routePath) {
  const names = []
  for (const match of routePath.matchAll(/:([a-zA-Z0-9_]+)/g)) {
    names.push(match[1])
  }
  return names
}

function resolveCommand(groupName, actionName) {
  const group = GROUP_INDEX.get(normalizeGroupName(groupName))
  if (!group) return null
  if (!actionName) return null
  return COMMAND_INDEX.get(`${group.name}:${actionName}`) || null
}

function resolveGroup(groupName) {
  return GROUP_INDEX.get(normalizeGroupName(groupName)) || null
}

function normalizeBaseUrl(rawBaseUrl) {
  let base = (rawBaseUrl || 'http://localhost:3456').trim()
  if (!base) base = 'http://localhost:3456'
  if (!/^https?:\/\//i.test(base)) {
    base = `http://${base}`
  }
  return base.replace(/\/+$/, '')
}

function buildApiUrl(baseUrl, routePath, queryEntries = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const prefix = normalizedBase.endsWith('/api') ? '' : '/api'
  const url = new URL(`${normalizedBase}${prefix}${routePath}`)
  for (const [key, value] of Object.entries(queryEntries)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url
}

function parseKeyValueEntries(entries) {
  const out = {}
  for (const entry of entries || []) {
    const idx = entry.indexOf('=')
    if (idx === -1) {
      throw new Error(`Expected key=value pair, got: ${entry}`)
    }
    const key = entry.slice(0, idx).trim()
    const value = entry.slice(idx + 1)
    if (!key) {
      throw new Error(`Invalid key=value pair: ${entry}`)
    }
    out[key] = value
  }
  return out
}

function getDefaultAccessKey(env, cwd) {
  const direct = env.SWARMCLAW_API_KEY || env.SWARMCLAW_ACCESS_KEY || env.API_KEY || ''
  if (direct.trim()) return direct.trim()

  const keyFile = path.join(cwd, 'platform-api-key.txt')
  try {
    if (fs.existsSync(keyFile)) {
      const key = fs.readFileSync(keyFile, 'utf8').trim()
      if (key) return key
    }
  } catch {
    // Ignore key file read failures and continue without auth header.
  }

  return ''
}

async function readStdinAll(stdin) {
  if (!stdin) return ''
  let text = ''
  for await (const chunk of stdin) {
    text += chunk.toString()
  }
  return text
}

async function readDataArg(dataArg, stdin, cwd) {
  if (!dataArg) return undefined

  if (dataArg === '-') {
    const text = await readStdinAll(stdin)
    if (!text.trim()) return undefined
    return JSON.parse(text)
  }

  if (dataArg.startsWith('@')) {
    const filePath = path.resolve(cwd, dataArg.slice(1))
    const text = fs.readFileSync(filePath, 'utf8')
    if (!text.trim()) return undefined
    return JSON.parse(text)
  }

  return JSON.parse(dataArg)
}

async function buildRequestBody(command, parsed, stdin, cwd) {
  let body

  if (command.requestType !== 'upload' && parsed.flags.data) {
    body = await readDataArg(parsed.flags.data, stdin, cwd)
  }

  if (command.defaultBody) {
    if (!isPlainObject(body)) body = {}
    body = { ...command.defaultBody, ...body }
  }

  if (command.bodyFlagMap) {
    if (!isPlainObject(body)) body = {}
    for (const [flagName, bodyKey] of Object.entries(command.bodyFlagMap)) {
      const value = parsed.flags[flagName]
      if (value !== undefined && value !== null) {
        body[bodyKey] = value
      }
    }
  }

  if (command.requiresBody && body === undefined && command.requestType !== 'upload') {
    throw new Error(`Command ${command.group} ${command.name} requires request body. Use --data '{...}'.`)
  }

  return body
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function applyPathParams(routePath, paramValues) {
  const paramNames = extractPathParamNames(routePath)
  if (paramValues.length < paramNames.length) {
    const missing = paramNames.slice(paramValues.length).join(', ')
    throw new Error(`Missing required path args: ${missing}`)
  }

  let builtPath = routePath
  for (let i = 0; i < paramNames.length; i += 1) {
    const raw = paramValues[i]
    builtPath = builtPath.replace(`:${paramNames[i]}`, encodeURIComponent(raw))
  }

  return {
    path: builtPath,
    consumed: paramNames.length,
  }
}

function serializeJson(value, compact) {
  if (compact) return `${JSON.stringify(value)}\n`
  return `${JSON.stringify(value, null, 2)}\n`
}

function isLikelyText(contentType) {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  return ct.startsWith('text/')
    || ct.includes('json')
    || ct.includes('xml')
    || ct.includes('yaml')
    || ct.includes('javascript')
}

async function readResponsePayload(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase()

  if (contentType.includes('application/json')) {
    return { kind: 'json', contentType, value: await response.json() }
  }

  if (isLikelyText(contentType)) {
    return { kind: 'text', contentType, value: await response.text() }
  }

  const buf = Buffer.from(await response.arrayBuffer())
  return { kind: 'binary', contentType, value: buf }
}

async function consumeSse(response, io, compactJson) {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const splitAt = buffer.indexOf('\n\n')
      if (splitAt === -1) break
      const block = buffer.slice(0, splitAt)
      buffer = buffer.slice(splitAt + 2)
      renderSseBlock(block, io, compactJson)
    }
  }

  if (buffer.trim()) {
    renderSseBlock(buffer, io, compactJson)
  }
}

function renderSseBlock(block, io, compactJson) {
  const lines = block.split('\n')
  const data = []
  for (const line of lines) {
    if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }

  if (data.length === 0) return
  const payload = data.join('\n')

  try {
    const parsed = JSON.parse(payload)
    if (parsed && typeof parsed === 'object' && parsed.t === 'md' && typeof parsed.text === 'string') {
      io.stdout.write(`${parsed.text}\n`)
      return
    }
    if (parsed && typeof parsed === 'object' && parsed.t === 'err' && typeof parsed.text === 'string') {
      io.stderr.write(`${parsed.text}\n`)
      return
    }
    io.stdout.write(serializeJson(parsed, compactJson))
  } catch {
    io.stdout.write(`${payload}\n`)
  }
}

async function fetchJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init)
  const payload = await readResponsePayload(res)
  if (!res.ok) {
    const message = payload.kind === 'json'
      ? JSON.stringify(payload.value)
      : payload.kind === 'text'
        ? payload.value
        : `HTTP ${res.status}`
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${message}`)
  }
  if (payload.kind !== 'json') {
    throw new Error(`Expected JSON response from ${url}, got ${payload.contentType || 'unknown content-type'}`)
  }
  return payload.value
}

async function waitForOperation({
  payload,
  fetchImpl,
  baseUrl,
  accessKey,
  waitIntervalMs,
  waitTimeoutMs,
  io,
  sleep,
}) {
  if (!isPlainObject(payload)) return null

  if (payload.runId) {
    const runId = String(payload.runId)
    io.stderr.write(`Waiting for run ${runId}...\n`)
    return pollUntil({
      label: `run ${runId}`,
      waitIntervalMs,
      waitTimeoutMs,
      sleep,
      io,
      poll: async () => fetchJson(fetchImpl, buildApiUrl(baseUrl, `/runs/${encodeURIComponent(runId)}`), {
        method: 'GET',
        headers: buildDefaultHeaders(accessKey),
      }),
      isDone: (value) => isPlainObject(value) && TERMINAL_RUN_STATUS.has(value.status),
    })
  }

  if (payload.taskId) {
    const taskId = String(payload.taskId)
    io.stderr.write(`Waiting for task ${taskId}...\n`)
    return pollUntil({
      label: `task ${taskId}`,
      waitIntervalMs,
      waitTimeoutMs,
      sleep,
      io,
      poll: async () => fetchJson(fetchImpl, buildApiUrl(baseUrl, `/tasks/${encodeURIComponent(taskId)}`), {
        method: 'GET',
        headers: buildDefaultHeaders(accessKey),
      }),
      isDone: (value) => isPlainObject(value) && TERMINAL_TASK_STATUS.has(value.status),
    })
  }

  return null
}

async function pollUntil({ label, waitIntervalMs, waitTimeoutMs, sleep, io, poll, isDone }) {
  const startedAt = Date.now()
  let lastStatus = null

  while (true) {
    const value = await poll()
    const status = isPlainObject(value) && typeof value.status === 'string' ? value.status : null

    if (status && status !== lastStatus) {
      io.stderr.write(`${label}: ${status}\n`)
      lastStatus = status
    }

    if (isDone(value)) {
      return value
    }

    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${waitTimeoutMs}ms`)
    }

    await sleep(waitIntervalMs)
  }
}

function buildDefaultHeaders(accessKey) {
  const headers = {}
  if (accessKey) {
    headers['X-Access-Key'] = accessKey
  }
  return headers
}

function getVersion(cwd) {
  const packagePath = path.resolve(cwd, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function printGeneralHelp(io, cwd) {
  const lines = []
  lines.push('SwarmClaw CLI')
  lines.push('')
  lines.push(`Version: ${getVersion(cwd)}`)
  lines.push('')
  lines.push('Usage:')
  lines.push('  swarmclaw <group> <command> [args] [options]')
  lines.push('  swarmclaw help [group]')
  lines.push('')
  lines.push('Global options:')
  lines.push('  --json                 Output compact JSON')
  lines.push('  --wait                 Wait for long-running run/task operations')
  lines.push('  --wait-interval <ms>   Poll interval for --wait (default: 1000)')
  lines.push('  --wait-timeout <ms>    Poll timeout for --wait (default: 300000)')
  lines.push('  --base-url <url>       API base URL (default: http://localhost:3456)')
  lines.push('  --access-key <key>     Override access key header')
  lines.push('  --data <json|@file|->  Request JSON body')
  lines.push('  --query key=value      Append query parameter (repeatable)')
  lines.push('  --header key=value     Append custom header (repeatable)')
  lines.push('  --out <path>           Write binary response to file')
  lines.push('  --help                 Show help')
  lines.push('  --version              Show version')
  lines.push('')
  lines.push('Auth key resolution order:')
  lines.push('  1) --access-key / --api-key')
  lines.push('  2) SWARMCLAW_API_KEY / SWARMCLAW_ACCESS_KEY / API_KEY')
  lines.push('  3) ./platform-api-key.txt')
  lines.push('')
  lines.push('Command groups:')

  for (const group of COMMAND_GROUPS) {
    lines.push(`  ${group.name.padEnd(14)} ${group.description}`)
  }

  lines.push('')
  lines.push('Aliases: memories -> memory, uploads/upload/docs -> documents')
  lines.push('')
  lines.push('Example:')
  lines.push('  swarmclaw tasks create --data \"{\\\"title\\\":\\\"Investigate issue\\\"}\"')

  io.stdout.write(`${lines.join('\n')}\n`)
}

function printGroupHelp(group, io) {
  const lines = []
  lines.push(`Group: ${group.name}`)
  lines.push(group.description)
  lines.push('')
  lines.push('Commands:')

  for (const command of group.commands) {
    const params = extractPathParamNames(command.path)
    const args = params.length ? ` ${params.map((name) => `<${name}>`).join(' ')}` : ''
    lines.push(`  ${command.name}${args}`)
    lines.push(`    ${command.method} /api${command.path} - ${command.description}`)
  }

  io.stdout.write(`${lines.join('\n')}\n`)
}

function isCommandHelpRequest(parsed) {
  if (parsed.positionals.length === 0) return true

  if (parsed.positionals[0] === 'help') return true

  if (parsed.flags.help) return true

  if (parsed.positionals.length === 1) return true

  return false
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runCli(argv, deps = {}) {
  const io = {
    stdout: deps.stdout || process.stdout,
    stderr: deps.stderr || process.stderr,
    stdin: deps.stdin || process.stdin,
  }

  const env = deps.env || process.env
  const cwd = deps.cwd || process.cwd()
  const sleep = deps.sleep || defaultSleep
  const fetchImpl = deps.fetch || globalThis.fetch

  if (typeof fetchImpl !== 'function') {
    io.stderr.write('Global fetch is not available in this Node runtime.\n')
    return 1
  }

  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (err) {
    io.stderr.write(`${err.message}\n`)
    return 1
  }

  if (parsed.flags.version) {
    io.stdout.write(`${getVersion(cwd)}\n`)
    return 0
  }

  if (parsed.positionals[0] === 'help') {
    if (parsed.positionals[1]) {
      const group = resolveGroup(parsed.positionals[1])
      if (!group) {
        io.stderr.write(`Unknown command group: ${parsed.positionals[1]}\n`)
        return 1
      }
      printGroupHelp(group, io)
      return 0
    }
    printGeneralHelp(io, cwd)
    return 0
  }

  if (isCommandHelpRequest(parsed)) {
    if (parsed.positionals[0]) {
      const maybeGroup = resolveGroup(parsed.positionals[0])
      if (maybeGroup) {
        printGroupHelp(maybeGroup, io)
        return 0
      }
    }
    printGeneralHelp(io, cwd)
    return 0
  }

  const groupName = parsed.positionals[0]
  const actionName = parsed.positionals[1]
  const command = resolveCommand(groupName, actionName)
  if (!command) {
    io.stderr.write(`Unknown command: ${groupName} ${actionName}\n`)
    const group = resolveGroup(groupName)
    if (group) printGroupHelp(group, io)
    return 1
  }

  const commandArgs = parsed.positionals.slice(2)
  let builtPath
  let consumed = 0

  try {
    const result = applyPathParams(command.path, commandArgs)
    builtPath = result.path
    consumed = result.consumed
  } catch (err) {
    io.stderr.write(`${err.message}\n`)
    return 1
  }

  const remainingArgs = commandArgs.slice(consumed)

  let requestBody
  try {
    requestBody = await buildRequestBody(command, parsed, io.stdin, cwd)
  } catch (err) {
    io.stderr.write(`${err.message}\n`)
    return 1
  }

  if (command.requestType === 'upload') {
    const inputPath = parsed.flags.file || remainingArgs[0]
    if (!inputPath) {
      io.stderr.write('Upload command requires a file path argument or --file <path>.\n')
      return 1
    }
    if (remainingArgs.length > 1 && !parsed.flags.file) {
      io.stderr.write('Too many positional arguments for upload command.\n')
      return 1
    }

    const resolved = path.resolve(cwd, inputPath)
    if (!fs.existsSync(resolved)) {
      io.stderr.write(`Upload file not found: ${resolved}\n`)
      return 1
    }

    requestBody = fs.readFileSync(resolved)
    if (!parsed.flags.filename) {
      parsed.flags.filename = path.basename(resolved)
    }
  } else if (remainingArgs.length > 0) {
    io.stderr.write(`Unexpected positional arguments: ${remainingArgs.join(' ')}\n`)
    return 1
  }

  const queryEntries = parseKeyValueEntries(parsed.flags.query)
  if (parsed.flags.event) {
    queryEntries.event = parsed.flags.event
  }

  const accessKey = (parsed.flags.accessKey || getDefaultAccessKey(env, cwd) || '').trim()
  const headers = {
    ...buildDefaultHeaders(accessKey),
    ...parseKeyValueEntries(parsed.flags.header),
  }

  if (parsed.flags.secret) {
    headers['x-webhook-secret'] = parsed.flags.secret
  }

  if (command.requestType === 'upload') {
    headers['x-filename'] = parsed.flags.filename || 'upload.bin'
  } else if (requestBody !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const url = buildApiUrl(parsed.flags.baseUrl, builtPath, queryEntries)

  const init = {
    method: command.method,
    headers,
  }

  if (command.requestType === 'upload') {
    init.body = requestBody
  } else if (requestBody !== undefined) {
    init.body = JSON.stringify(requestBody)
  }

  let response
  try {
    response = await fetchImpl(url, init)
  } catch (err) {
    io.stderr.write(`Request failed: ${err.message || String(err)}\n`)
    return 1
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()

  if (contentType.includes('text/event-stream') || command.streamResponse || parsed.flags.stream) {
    if (!response.ok) {
      const payload = await readResponsePayload(response)
      const message = payload.kind === 'json'
        ? JSON.stringify(payload.value)
        : payload.kind === 'text'
          ? payload.value
          : `HTTP ${response.status}`
      io.stderr.write(`HTTP ${response.status} ${response.statusText}: ${message}\n`)
      return 1
    }

    try {
      await consumeSse(response, io, parsed.flags.json)
      return 0
    } catch (err) {
      io.stderr.write(`Failed reading stream: ${err.message || String(err)}\n`)
      return 1
    }
  }

  let payload
  try {
    payload = await readResponsePayload(response)
  } catch (err) {
    io.stderr.write(`Failed to read response: ${err.message || String(err)}\n`)
    return 1
  }

  if (!response.ok) {
    const message = payload.kind === 'json'
      ? JSON.stringify(payload.value)
      : payload.kind === 'text'
        ? payload.value
        : `binary payload (${payload.value.length} bytes)`
    io.stderr.write(`HTTP ${response.status} ${response.statusText}: ${message}\n`)
    return 1
  }

  if (payload.kind === 'binary' || command.responseType === 'binary') {
    if (parsed.flags.out) {
      const outPath = path.resolve(cwd, parsed.flags.out)
      fs.writeFileSync(outPath, payload.value)
      if (!parsed.flags.json) {
        io.stdout.write(`Wrote ${payload.value.length} bytes to ${outPath}\n`)
      }
      return 0
    }

    if (io.stdout.isTTY) {
      io.stderr.write('Refusing to print binary response to terminal. Use --out <path>.\n')
      return 1
    }

    io.stdout.write(payload.value)
    return 0
  }

  let outputValue = payload.value

  if (parsed.flags.wait && payload.kind === 'json') {
    try {
      const waitResult = await waitForOperation({
        payload: payload.value,
        fetchImpl,
        baseUrl: parsed.flags.baseUrl,
        accessKey,
        waitIntervalMs: parsed.flags.waitIntervalMs,
        waitTimeoutMs: parsed.flags.waitTimeoutMs,
        io,
        sleep,
      })

      if (waitResult !== null) {
        if (isPlainObject(outputValue)) {
          outputValue = { ...outputValue, waitResult }
        } else {
          outputValue = { result: outputValue, waitResult }
        }
      }
    } catch (err) {
      io.stderr.write(`${err.message || String(err)}\n`)
      return 1
    }
  }

  if (payload.kind === 'json') {
    io.stdout.write(serializeJson(outputValue, parsed.flags.json))
    return 0
  }

  io.stdout.write(`${String(outputValue)}\n`)
  return 0
}

module.exports = {
  COMMAND_GROUPS,
  COMMANDS,
  GROUP_ALIASES,
  parseArgv,
  resolveCommand,
  resolveGroup,
  buildApiUrl,
  getDefaultAccessKey,
  runCli,
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((err) => {
    process.stderr.write(`${err.message || String(err)}\n`)
    process.exitCode = 1
  })
}
