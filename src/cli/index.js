'use strict'

const fs = require('fs')
const path = require('path')

function cmd(action, method, route, description, extra = {}) {
  return { action, method, route, description, ...extra }
}

const COMMAND_GROUPS = [
  {
    name: 'agents',
    description: 'Manage agents',
    commands: [
      cmd('list', 'GET', '/agents', 'List agents'),
      cmd('get', 'GET', '/agents/:id', 'Get an agent by id', { virtual: true, clientGetRoute: '/agents' }),
      cmd('create', 'POST', '/agents', 'Create an agent', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/agents/:id', 'Update an agent', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/agents/:id', 'Delete an agent'),
      cmd('generate', 'POST', '/agents/generate', 'Generate agent definition from prompt', { expectsJsonBody: true }),
      cmd('thread', 'POST', '/agents/:id/thread', 'Get or create agent thread session'),
    ],
  },
  {
    name: 'auth',
    description: 'Access key auth helpers',
    commands: [
      cmd('status', 'GET', '/auth', 'Check auth setup status'),
      cmd('login', 'POST', '/auth', 'Validate an access key', {
        expectsJsonBody: true,
        bodyFlagMap: { key: 'key' },
      }),
    ],
  },
  {
    name: 'claude-skills',
    description: 'Read local Claude skills directory metadata',
    commands: [
      cmd('list', 'GET', '/claude-skills', 'List Claude skills discovered on host'),
    ],
  },
  {
    name: 'clawhub',
    description: 'Browse and install ClawHub skills',
    commands: [
      cmd('search', 'GET', '/clawhub/search', 'Search ClawHub skills catalog'),
      cmd('install', 'POST', '/clawhub/install', 'Install a skill from ClawHub', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'connectors',
    description: 'Manage chat connectors',
    commands: [
      cmd('list', 'GET', '/connectors', 'List connectors'),
      cmd('get', 'GET', '/connectors/:id', 'Get connector'),
      cmd('create', 'POST', '/connectors', 'Create connector', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/connectors/:id', 'Update connector', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/connectors/:id', 'Delete connector'),
      cmd('start', 'PUT', '/connectors/:id', 'Start connector', {
        expectsJsonBody: true,
        defaultBody: { action: 'start' },
      }),
      cmd('stop', 'PUT', '/connectors/:id', 'Stop connector', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop' },
      }),
      cmd('repair', 'PUT', '/connectors/:id', 'Repair connector', {
        expectsJsonBody: true,
        defaultBody: { action: 'repair' },
      }),
    ],
  },
  {
    name: 'credentials',
    description: 'Manage encrypted provider credentials',
    commands: [
      cmd('list', 'GET', '/credentials', 'List credentials'),
      cmd('get', 'GET', '/credentials/:id', 'Get credential metadata by id', { virtual: true, clientGetRoute: '/credentials' }),
      cmd('create', 'POST', '/credentials', 'Create credential', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/credentials/:id', 'Delete credential'),
    ],
  },
  {
    name: 'daemon',
    description: 'Control background daemon',
    commands: [
      cmd('status', 'GET', '/daemon', 'Get daemon status'),
      cmd('action', 'POST', '/daemon', 'Set daemon action via JSON body', { expectsJsonBody: true }),
      cmd('start', 'POST', '/daemon', 'Start daemon', {
        expectsJsonBody: true,
        defaultBody: { action: 'start' },
      }),
      cmd('stop', 'POST', '/daemon', 'Stop daemon', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop' },
      }),
      cmd('health-check', 'POST', '/daemon/health-check', 'Run daemon health checks immediately'),
    ],
  },
  {
    name: 'dirs',
    description: 'Directory listing and native picker',
    commands: [
      cmd('list', 'GET', '/dirs', 'List directories (use --query path=/abs/path)'),
      cmd('pick', 'POST', '/dirs/pick', 'Open native picker (mode=file|folder)', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'documents',
    description: 'Manage documents',
    commands: [
      cmd('list', 'GET', '/documents', 'List documents'),
      cmd('get', 'GET', '/documents/:id', 'Get document by id'),
      cmd('create', 'POST', '/documents', 'Create document', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/documents/:id', 'Update document', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/documents/:id', 'Delete document'),
    ],
  },
  {
    name: 'files',
    description: 'Serve and manage local files',
    commands: [
      cmd('serve', 'GET', '/files/serve', 'Serve a local file (use --query path=/abs/path)'),
    ],
  },
  {
    name: 'generate',
    description: 'AI generation endpoints',
    commands: [
      cmd('run', 'POST', '/generate', 'Generate schedule/task/skill/provider payload', { expectsJsonBody: true }),
      cmd('info', 'GET', '/generate/info', 'Get generation provider/model info'),
    ],
  },
  {
    name: 'ip',
    description: 'Get local IP/port metadata',
    commands: [
      cmd('get', 'GET', '/ip', 'Get host IP and port'),
    ],
  },
  {
    name: 'knowledge',
    description: 'Manage knowledge base entries',
    commands: [
      cmd('list', 'GET', '/knowledge', 'List knowledge entries'),
      cmd('get', 'GET', '/knowledge/:id', 'Get knowledge entry by id'),
      cmd('create', 'POST', '/knowledge', 'Create knowledge entry', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/knowledge/:id', 'Update knowledge entry', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/knowledge/:id', 'Delete knowledge entry'),
      cmd('upload', 'POST', '/knowledge/upload', 'Upload document for knowledge extraction', {
        requestType: 'upload',
        inputPositional: 'filePath',
      }),
    ],
  },
  {
    name: 'logs',
    description: 'Read or clear app logs',
    commands: [
      cmd('list', 'GET', '/logs', 'List logs (use --query lines=200, --query level=INFO,ERROR)'),
      cmd('clear', 'DELETE', '/logs', 'Clear logs file'),
    ],
  },
  {
    name: 'memory',
    description: 'Manage memory entries',
    commands: [
      cmd('list', 'GET', '/memory', 'List memory entries (use --query q=, --query agentId=)'),
      cmd('get', 'GET', '/memory/:id', 'Get memory by id'),
      cmd('create', 'POST', '/memory', 'Create memory entry', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/memory/:id', 'Update memory entry', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/memory/:id', 'Delete memory entry'),
      cmd('maintenance', 'GET', '/memory/maintenance', 'Analyze memory dedupe/prune candidates'),
      cmd('maintenance-run', 'POST', '/memory/maintenance', 'Run memory dedupe/prune maintenance', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'memory-images',
    description: 'Fetch stored memory image assets',
    commands: [
      cmd('get', 'GET', '/memory-images/:filename', 'Download memory image by filename', { responseType: 'binary' }),
    ],
  },
  {
    name: 'mcp-servers',
    description: 'Manage MCP server configurations',
    commands: [
      cmd('list', 'GET', '/mcp-servers', 'List MCP servers'),
      cmd('get', 'GET', '/mcp-servers/:id', 'Get MCP server by id'),
      cmd('create', 'POST', '/mcp-servers', 'Create MCP server', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/mcp-servers/:id', 'Update MCP server', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/mcp-servers/:id', 'Delete MCP server'),
      cmd('test', 'POST', '/mcp-servers/:id/test', 'Test MCP server connection'),
      cmd('tools', 'GET', '/mcp-servers/:id/tools', 'List tools available on an MCP server'),
    ],
  },
  {
    name: 'memories',
    description: 'Alias of memory command group',
    aliasFor: 'memory',
    commands: [],
  },
  {
    name: 'orchestrator',
    description: 'Trigger orchestrator runs',
    commands: [
      cmd('run', 'POST', '/orchestrator/run', 'Queue orchestrator task', {
        expectsJsonBody: true,
        waitEntityFrom: 'taskId',
      }),
    ],
  },
  {
    name: 'preview-server',
    description: 'Manage preview dev servers',
    commands: [
      cmd('manage', 'POST', '/preview-server', 'Start/stop/status/detect preview server', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'plugins',
    description: 'Manage plugins and marketplace',
    commands: [
      cmd('list', 'GET', '/plugins', 'List installed plugins'),
      cmd('set', 'POST', '/plugins', 'Enable/disable plugin', { expectsJsonBody: true }),
      cmd('install', 'POST', '/plugins/install', 'Install plugin from URL', { expectsJsonBody: true }),
      cmd('marketplace', 'GET', '/plugins/marketplace', 'Get marketplace catalog'),
    ],
  },
  {
    name: 'providers',
    description: 'Manage providers and model overrides',
    commands: [
      cmd('list', 'GET', '/providers', 'List providers'),
      cmd('get', 'GET', '/providers/:id', 'Get provider config'),
      cmd('create', 'POST', '/providers', 'Create custom provider', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/providers/:id', 'Update provider', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/providers/:id', 'Delete provider'),
      cmd('configs', 'GET', '/providers/configs', 'List saved provider configs'),
      cmd('ollama', 'GET', '/providers/ollama', 'List local Ollama models (use --query endpoint=http://localhost:11434)'),
      cmd('openclaw-health', 'GET', '/providers/openclaw/health', 'Probe OpenClaw endpoint/auth (use --query endpoint= --query credentialId= --query model=)'),
      cmd('models', 'GET', '/providers/:id/models', 'Get provider model overrides'),
      cmd('models-set', 'PUT', '/providers/:id/models', 'Set provider model overrides', { expectsJsonBody: true }),
      cmd('models-clear', 'DELETE', '/providers/:id/models', 'Clear provider model overrides'),
    ],
  },
  {
    name: 'runs',
    description: 'Session run queue/history',
    commands: [
      cmd('list', 'GET', '/runs', 'List runs (use --query sessionId=, --query status=, --query limit=)'),
      cmd('get', 'GET', '/runs/:id', 'Get run by id'),
    ],
  },
  {
    name: 'schedules',
    description: 'Manage schedules',
    commands: [
      cmd('list', 'GET', '/schedules', 'List schedules'),
      cmd('get', 'GET', '/schedules/:id', 'Get schedule by id', { virtual: true, clientGetRoute: '/schedules' }),
      cmd('create', 'POST', '/schedules', 'Create schedule', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/schedules/:id', 'Update schedule', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/schedules/:id', 'Delete schedule'),
      cmd('run', 'POST', '/schedules/:id/run', 'Trigger schedule now'),
    ],
  },
  {
    name: 'secrets',
    description: 'Manage reusable encrypted secrets',
    commands: [
      cmd('list', 'GET', '/secrets', 'List secrets metadata'),
      cmd('get', 'GET', '/secrets/:id', 'Get secret metadata by id', { virtual: true, clientGetRoute: '/secrets' }),
      cmd('create', 'POST', '/secrets', 'Create secret', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/secrets/:id', 'Update secret metadata', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/secrets/:id', 'Delete secret'),
    ],
  },
  {
    name: 'sessions',
    description: 'Manage chat sessions and runtime controls',
    commands: [
      cmd('list', 'GET', '/sessions', 'List sessions'),
      cmd('get', 'GET', '/sessions/:id', 'Get session by id', { virtual: true, clientGetRoute: '/sessions' }),
      cmd('create', 'POST', '/sessions', 'Create session', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/sessions/:id', 'Update session', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/sessions/:id', 'Delete session'),
      cmd('delete-many', 'DELETE', '/sessions', 'Delete multiple sessions (body: {"ids":[...]})', { expectsJsonBody: true }),
      cmd('heartbeat-disable-all', 'POST', '/sessions/heartbeat', 'Disable all session heartbeats and cancel queued heartbeat runs', {
        expectsJsonBody: true,
        defaultBody: { action: 'disable_all' },
      }),
      cmd('messages', 'GET', '/sessions/:id/messages', 'Get session messages'),
      cmd('main-loop', 'GET', '/sessions/:id/main-loop', 'Get main mission loop state'),
      cmd('main-loop-action', 'POST', '/sessions/:id/main-loop', 'Control main mission loop (pause/resume/set_goal/set_mode/clear_events/nudge)', {
        expectsJsonBody: true,
      }),
      cmd('chat', 'POST', '/sessions/:id/chat', 'Send chat message (streaming)', {
        expectsJsonBody: true,
        responseType: 'sse',
      }),
      cmd('stop', 'POST', '/sessions/:id/stop', 'Stop session run(s)'),
      cmd('clear', 'POST', '/sessions/:id/clear', 'Clear session messages'),
      cmd('browser-status', 'GET', '/sessions/:id/browser', 'Check browser status'),
      cmd('browser-close', 'DELETE', '/sessions/:id/browser', 'Close browser session'),
      cmd('mailbox', 'GET', '/sessions/:id/mailbox', 'List session mailbox envelopes'),
      cmd('mailbox-action', 'POST', '/sessions/:id/mailbox', 'Send/ack/clear mailbox envelopes', { expectsJsonBody: true }),
      cmd('retry', 'POST', '/sessions/:id/retry', 'Retry last assistant message'),
      cmd('deploy', 'POST', '/sessions/:id/deploy', 'Deploy current session branch', { expectsJsonBody: true }),
      cmd('devserver', 'POST', '/sessions/:id/devserver', 'Dev server action via JSON body', { expectsJsonBody: true }),
      cmd('devserver-start', 'POST', '/sessions/:id/devserver', 'Start session dev server', {
        expectsJsonBody: true,
        defaultBody: { action: 'start' },
      }),
      cmd('devserver-stop', 'POST', '/sessions/:id/devserver', 'Stop session dev server', {
        expectsJsonBody: true,
        defaultBody: { action: 'stop' },
      }),
      cmd('devserver-status', 'POST', '/sessions/:id/devserver', 'Check session dev server status', {
        expectsJsonBody: true,
        defaultBody: { action: 'status' },
      }),
    ],
  },
  {
    name: 'settings',
    description: 'Read/update app settings',
    commands: [
      cmd('get', 'GET', '/settings', 'Get settings'),
      cmd('update', 'PUT', '/settings', 'Update settings', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'setup',
    description: 'Setup and provider validation helpers',
    commands: [
      cmd('check-provider', 'POST', '/setup/check-provider', 'Validate provider credentials/endpoint', { expectsJsonBody: true }),
      cmd('doctor', 'GET', '/setup/doctor', 'Run local setup diagnostics'),
    ],
  },
  {
    name: 'skills',
    description: 'Manage reusable skills',
    commands: [
      cmd('list', 'GET', '/skills', 'List skills'),
      cmd('get', 'GET', '/skills/:id', 'Get skill'),
      cmd('create', 'POST', '/skills', 'Create skill', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/skills/:id', 'Update skill', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/skills/:id', 'Delete skill'),
      cmd('import', 'POST', '/skills/import', 'Import skill from URL', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'tasks',
    description: 'Manage task board items',
    commands: [
      cmd('list', 'GET', '/tasks', 'List tasks'),
      cmd('get', 'GET', '/tasks/:id', 'Get task'),
      cmd('create', 'POST', '/tasks', 'Create task', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/tasks/:id', 'Update task', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/tasks/:id', 'Delete task'),
      cmd('purge', 'DELETE', '/tasks', 'Bulk delete tasks', { expectsJsonBody: true }),
    ],
  },
  {
    name: 'tts',
    description: 'Text-to-speech endpoint',
    commands: [
      cmd('speak', 'POST', '/tts', 'Generate TTS audio', {
        expectsJsonBody: true,
        responseType: 'binary',
        bodyFlagMap: { text: 'text' },
      }),
    ],
  },
  {
    name: 'upload',
    description: 'Upload raw file/blob',
    commands: [
      cmd('file', 'POST', '/upload', 'Upload file', {
        requestType: 'upload',
        inputPositional: 'filePath',
      }),
    ],
  },
  {
    name: 'uploads',
    description: 'Fetch uploaded artifacts',
    commands: [
      cmd('get', 'GET', '/uploads/:filename', 'Download uploaded artifact', { responseType: 'binary' }),
    ],
  },
  {
    name: 'usage',
    description: 'Usage and cost summary',
    commands: [
      cmd('get', 'GET', '/usage', 'Get usage summary'),
    ],
  },
  {
    name: 'version',
    description: 'Version and update checks',
    commands: [
      cmd('get', 'GET', '/version', 'Get local/remote version info'),
      cmd('update', 'POST', '/version/update', 'Update to latest stable release tag (fallback: main) and install deps when needed'),
    ],
  },
  {
    name: 'webhooks',
    description: 'Manage and trigger webhooks',
    commands: [
      cmd('list', 'GET', '/webhooks', 'List webhooks'),
      cmd('get', 'GET', '/webhooks/:id', 'Get webhook by id'),
      cmd('create', 'POST', '/webhooks', 'Create webhook', { expectsJsonBody: true }),
      cmd('update', 'PUT', '/webhooks/:id', 'Update webhook', { expectsJsonBody: true }),
      cmd('delete', 'DELETE', '/webhooks/:id', 'Delete webhook'),
      cmd('trigger', 'POST', '/webhooks/:id', 'Trigger webhook by id', {
        expectsJsonBody: true,
        waitEntityFrom: 'runId',
      }),
      cmd('history', 'GET', '/webhooks/:id/history', 'Get webhook delivery history'),
    ],
  },
]

const GROUP_MAP = new Map(COMMAND_GROUPS.map((group) => [group.name, group]))

function resolveGroup(name) {
  const group = GROUP_MAP.get(name)
  if (!group) return null
  if (group.aliasFor) {
    return GROUP_MAP.get(group.aliasFor) || null
  }
  return group
}

const COMMANDS = COMMAND_GROUPS.flatMap((group) => {
  if (group.aliasFor) return []
  return group.commands.map((command) => ({ ...command, group: group.name }))
})

function getCommand(groupName, action) {
  const group = resolveGroup(groupName)
  if (!group) return null
  return group.commands.find((command) => command.action === action) || null
}

function extractPathParams(route) {
  return [...route.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1])
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function parseKeyValue(raw, kind) {
  const idx = raw.indexOf('=')
  if (idx === -1) {
    throw new Error(`${kind} value must be key=value: ${raw}`)
  }
  const key = raw.slice(0, idx).trim()
  const value = raw.slice(idx + 1)
  if (!key) throw new Error(`${kind} key cannot be empty`)
  return [key, value]
}

function parseDataInput(raw, stdin) {
  if (raw === '-') {
    return parseJsonText(readStdin(stdin), 'stdin')
  }
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1)
    if (!filePath) throw new Error('Expected file path after @ for --data')
    const fileText = fs.readFileSync(filePath, 'utf8')
    return parseJsonText(fileText, filePath)
  }
  return parseJsonText(raw, '--data')
}

function parseJsonText(text, sourceName) {
  try {
    return JSON.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON from ${sourceName}: ${msg}`)
  }
}

function readStdin(stdin) {
  const fd = stdin && typeof stdin.fd === 'number' ? stdin.fd : 0
  return fs.readFileSync(fd, 'utf8')
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim()
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, '')
}

function resolveAccessKey(opts, env, cwd) {
  if (opts.accessKey) return String(opts.accessKey).trim()
  const envKey = env.SWARMCLAW_API_KEY || env.SC_ACCESS_KEY || ''
  if (envKey) return String(envKey).trim()

  const keyFile = path.join(cwd, 'platform-api-key.txt')
  if (fs.existsSync(keyFile)) {
    const content = fs.readFileSync(keyFile, 'utf8').trim()
    if (content) return content
  }
  return ''
}

function parseArgv(argv) {
  const result = {
    group: '',
    action: '',
    positionals: [],
    opts: {
      baseUrl: '',
      accessKey: '',
      jsonOutput: false,
      wait: false,
      timeoutMs: 300000,
      intervalMs: 2000,
      out: '',
      data: '',
      headers: [],
      query: [],
      key: '',
      text: '',
      file: '',
      filename: '',
      secret: '',
      event: '',
      help: false,
      version: false,
    },
  }

  const valueOptions = new Set([
    'base-url',
    'access-key',
    'timeout-ms',
    'interval-ms',
    'out',
    'data',
    'header',
    'query',
    'key',
    'text',
    'file',
    'filename',
    'secret',
    'event',
  ])

  const tokens = [...argv]
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      result.positionals.push(...tokens.slice(i + 1))
      break
    }

    if (token === '-h' || token === '--help') {
      result.opts.help = true
      continue
    }

    if (token === '--version') {
      result.opts.version = true
      continue
    }

    if (token === '--json') {
      result.opts.jsonOutput = true
      continue
    }

    if (token === '--wait') {
      result.opts.wait = true
      continue
    }

    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=')
      const hasInline = eqIndex > -1
      const rawName = hasInline ? token.slice(2, eqIndex) : token.slice(2)
      const rawValue = hasInline ? token.slice(eqIndex + 1) : ''

      if (!valueOptions.has(rawName)) {
        throw new Error(`Unknown option: --${rawName}`)
      }

      const value = hasInline ? rawValue : tokens[i + 1]
      if (!hasInline) i += 1
      if (value === undefined) {
        throw new Error(`Missing value for --${rawName}`)
      }

      switch (rawName) {
        case 'base-url':
          result.opts.baseUrl = value
          break
        case 'access-key':
          result.opts.accessKey = value
          break
        case 'timeout-ms':
          result.opts.timeoutMs = Number.parseInt(value, 10)
          if (!Number.isFinite(result.opts.timeoutMs) || result.opts.timeoutMs <= 0) {
            throw new Error(`Invalid --timeout-ms value: ${value}`)
          }
          break
        case 'interval-ms':
          result.opts.intervalMs = Number.parseInt(value, 10)
          if (!Number.isFinite(result.opts.intervalMs) || result.opts.intervalMs <= 0) {
            throw new Error(`Invalid --interval-ms value: ${value}`)
          }
          break
        case 'out':
          result.opts.out = value
          break
        case 'data':
          result.opts.data = value
          break
        case 'header':
          result.opts.headers.push(value)
          break
        case 'query':
          result.opts.query.push(value)
          break
        case 'key':
          result.opts.key = value
          break
        case 'text':
          result.opts.text = value
          break
        case 'file':
          result.opts.file = value
          break
        case 'filename':
          result.opts.filename = value
          break
        case 'secret':
          result.opts.secret = value
          break
        case 'event':
          result.opts.event = value
          break
        default:
          throw new Error(`Unhandled option parser branch: --${rawName}`)
      }
      continue
    }

    result.positionals.push(token)
  }

  if (result.positionals.length > 0) {
    result.group = result.positionals[0]
  }
  if (result.positionals.length > 1) {
    result.action = result.positionals[1]
  }

  return result
}

function buildRoute(routeTemplate, args) {
  const pathParams = extractPathParams(routeTemplate)
  if (args.length < pathParams.length) {
    throw new Error(`Missing required path args: ${pathParams.slice(args.length).join(', ')}`)
  }

  let route = routeTemplate
  for (let i = 0; i < pathParams.length; i += 1) {
    route = route.replace(`:${pathParams[i]}`, encodeURIComponent(String(args[i])))
  }

  const remaining = args.slice(pathParams.length)
  return { route, remaining, pathParams }
}

function buildApiUrl(baseUrl, route, queryEntries) {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const hasApiSuffix = normalizedBase.endsWith('/api')
  const url = new URL(`${normalizedBase}${hasApiSuffix ? '' : '/api'}${route}`)
  for (const [key, value] of queryEntries) {
    url.searchParams.set(key, value)
  }
  return url
}

async function parseResponse(res, forceType) {
  const ct = (res.headers.get('content-type') || '').toLowerCase()

  if (forceType === 'sse' || ct.includes('text/event-stream')) {
    return { type: 'sse', value: res.body }
  }

  if (forceType === 'binary') {
    const buf = Buffer.from(await res.arrayBuffer())
    return { type: 'binary', value: buf, contentType: ct }
  }

  if (ct.includes('application/json')) {
    const json = await res.json().catch(() => null)
    return { type: 'json', value: json }
  }

  if (ct.startsWith('text/') || ct.includes('xml') || ct.includes('javascript')) {
    const text = await res.text()
    return { type: 'text', value: text }
  }

  const buf = Buffer.from(await res.arrayBuffer())
  return { type: 'binary', value: buf, contentType: ct }
}

function writeJson(stdout, value, compact) {
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  stdout.write(`${text}\n`)
}

function writeText(stdout, value) {
  stdout.write(String(value))
  if (!String(value).endsWith('\n')) stdout.write('\n')
}

function writeBinary(stdout, stderr, buffer, outPath, cwd) {
  if (outPath) {
    const resolved = path.isAbsolute(outPath) ? outPath : path.join(cwd, outPath)
    fs.writeFileSync(resolved, buffer)
    stderr.write(`Saved ${buffer.length} bytes to ${resolved}\n`)
    return
  }

  if (stdout.isTTY) {
    throw new Error('Binary response requires --out <file> when writing to a TTY')
  }
  stdout.write(buffer)
}

async function consumeSse(body, stdout, stderr, jsonOutput) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Streaming response does not expose a reader')
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function flushChunk(rawChunk) {
    const lines = rawChunk
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)

    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())

    if (!dataLines.length) return
    const payload = dataLines.join('\n')

    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      writeText(stdout, payload)
      return
    }

    if (jsonOutput) {
      writeJson(stdout, parsed, true)
      return
    }

    if (isPlainObject(parsed) && parsed.t === 'md' && typeof parsed.text === 'string') {
      writeText(stdout, parsed.text)
      return
    }

    if (isPlainObject(parsed) && parsed.t === 'err' && typeof parsed.text === 'string') {
      writeText(stderr, parsed.text)
      return
    }

    writeJson(stdout, parsed, false)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let splitIndex = buffer.indexOf('\n\n')
    while (splitIndex >= 0) {
      const chunk = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + 2)
      flushChunk(chunk)
      splitIndex = buffer.indexOf('\n\n')
    }
  }

  const finalText = decoder.decode()
  if (finalText) buffer += finalText
  if (buffer.trim()) flushChunk(buffer)
}

async function fetchJson(fetchImpl, url, headers, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  const parsed = await parseResponse(res)
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${serializePayload(parsed.value)}`)
  }

  if (parsed.type !== 'json') {
    throw new Error(`Expected JSON response from ${url}`)
  }

  return parsed.value
}

function serializePayload(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getWaitId(payload, command) {
  if (!isPlainObject(payload)) return null

  if (command.waitEntityFrom && typeof payload[command.waitEntityFrom] === 'string') {
    return { type: command.waitEntityFrom === 'taskId' ? 'task' : 'run', id: payload[command.waitEntityFrom] }
  }

  if (typeof payload.runId === 'string') return { type: 'run', id: payload.runId }
  if (isPlainObject(payload.run) && typeof payload.run.id === 'string') return { type: 'run', id: payload.run.id }
  if (typeof payload.taskId === 'string') return { type: 'task', id: payload.taskId }

  return null
}

function isTerminalStatus(status) {
  const terminal = new Set([
    'completed',
    'complete',
    'done',
    'failed',
    'error',
    'stopped',
    'cancelled',
    'canceled',
    'timeout',
    'timed_out',
  ])
  return terminal.has(String(status || '').toLowerCase())
}

async function waitForEntity(opts) {
  const {
    entityType,
    entityId,
    fetchImpl,
    baseUrl,
    headers,
    timeoutMs,
    intervalMs,
    stdout,
    jsonOutput,
  } = opts

  const route = entityType === 'run' ? `/runs/${encodeURIComponent(entityId)}` : `/tasks/${encodeURIComponent(entityId)}`
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const url = buildApiUrl(baseUrl, route, [])
    const payload = await fetchJson(fetchImpl, url, headers, timeoutMs)

    const status = isPlainObject(payload) ? payload.status : undefined
    if (status !== undefined) {
      stdout.write(`[wait] ${entityType} ${entityId}: ${status}\n`)
    }

    if (status !== undefined && isTerminalStatus(status)) {
      if (jsonOutput) writeJson(stdout, payload, true)
      else writeJson(stdout, payload, false)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for ${entityType} ${entityId}`)
}

function renderGeneralHelp() {
  const lines = [
    'SwarmClaw CLI',
    '',
    'Usage:',
    '  swarmclaw <group> <command> [args] [options]',
    '',
    'Global options:',
    '  --base-url <url>       API base URL (default: http://localhost:3456)',
    '  --access-key <key>     Access key override (else SWARMCLAW_API_KEY or platform-api-key.txt)',
    '  --data <json|@file|->  Request JSON body',
    '  --query key=value      Query parameter (repeatable)',
    '  --header key=value     Extra HTTP header (repeatable)',
    '  --json                 Compact JSON output',
    '  --wait                 Wait for run/task completion when runId/taskId is returned',
    '  --timeout-ms <ms>      Request/wait timeout (default: 300000)',
    '  --interval-ms <ms>     Poll interval for --wait (default: 2000)',
    '  --out <file>           Write binary response to file',
    '  --help                 Show help',
    '  --version              Show package version',
    '',
    'Groups:',
  ]

  for (const group of COMMAND_GROUPS) {
    if (group.aliasFor) {
      lines.push(`  ${group.name} (alias for ${group.aliasFor})`)
    } else {
      lines.push(`  ${group.name}`)
    }
  }

  lines.push('', 'Use "swarmclaw <group> --help" for group commands.')
  return lines.join('\n')
}

function renderGroupHelp(groupName) {
  const group = GROUP_MAP.get(groupName)
  if (!group) {
    throw new Error(`Unknown command group: ${groupName}`)
  }

  const resolved = resolveGroup(groupName)
  if (!resolved) throw new Error(`Unable to resolve command group: ${groupName}`)

  const lines = [
    `Group: ${groupName}${group.aliasFor ? ` (alias for ${group.aliasFor})` : ''}`,
    group.description ? `Description: ${group.description}` : '',
    '',
    'Commands:',
  ].filter(Boolean)

  for (const command of resolved.commands) {
    const params = extractPathParams(command.route).map((name) => `<${name}>`).join(' ')
    const suffix = params ? ` ${params}` : ''
    lines.push(`  ${command.action}${suffix}  ${command.description}`)
  }

  return lines.join('\n')
}

async function runCli(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout
  const stderr = deps.stderr || process.stderr
  const stdin = deps.stdin || process.stdin
  const env = deps.env || process.env
  const cwd = deps.cwd || process.cwd()
  const fetchImpl = deps.fetchImpl || globalThis.fetch

  if (typeof fetchImpl !== 'function') {
    stderr.write('Global fetch is unavailable in this Node runtime. Use Node 18+ or provide a fetch implementation.\n')
    return 1
  }

  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (parsed.opts.version) {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    stdout.write(`${pkg.name || 'swarmclaw'} ${pkg.version || '0.0.0'}\n`)
    return 0
  }

  if (!parsed.group || parsed.opts.help) {
    if (parsed.group) {
      try {
        stdout.write(`${renderGroupHelp(parsed.group)}\n`)
        return 0
      } catch {
        // Fall through to general help for unknown group
      }
    }
    stdout.write(`${renderGeneralHelp()}\n`)
    return 0
  }

  if (!parsed.action) {
    try {
      stdout.write(`${renderGroupHelp(parsed.group)}\n`)
      return 0
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  const command = getCommand(parsed.group, parsed.action)
  if (!command) {
    stderr.write(`Unknown command: ${parsed.group} ${parsed.action}\n`)
    const group = resolveGroup(parsed.group)
    if (group) {
      stderr.write(`${renderGroupHelp(parsed.group)}\n`)
    } else {
      stderr.write(`${renderGeneralHelp()}\n`)
    }
    return 1
  }

  const pathArgs = parsed.positionals.slice(2)
  let routeInfo
  try {
    routeInfo = buildRoute(command.route, pathArgs)
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const accessKey = resolveAccessKey(parsed.opts, env, cwd)
  const baseUrl = parsed.opts.baseUrl || env.SWARMCLAW_BASE_URL || 'http://localhost:3456'

  const headerEntries = []
  for (const raw of parsed.opts.headers) {
    try {
      headerEntries.push(parseKeyValue(raw, 'header'))
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  if (parsed.opts.secret) {
    headerEntries.push(['x-webhook-secret', parsed.opts.secret])
  }

  const queryEntries = []
  for (const raw of parsed.opts.query) {
    try {
      queryEntries.push(parseKeyValue(raw, 'query'))
    } catch (err) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  if (parsed.opts.event) {
    queryEntries.push(['event', parsed.opts.event])
  }

  let url
  try {
    url = buildApiUrl(baseUrl, routeInfo.route, queryEntries)
  } catch (err) {
    stderr.write(`Invalid --base-url: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const headers = {
    ...Object.fromEntries(headerEntries),
  }
  if (accessKey) headers['X-Access-Key'] = accessKey

  try {
    if (command.clientGetRoute) {
      const collectionUrl = buildApiUrl(baseUrl, command.clientGetRoute, queryEntries)
      const payload = await fetchJson(fetchImpl, collectionUrl, headers, parsed.opts.timeoutMs)
      const id = pathArgs[0]
      const entity = extractById(payload, id)
      if (!entity) {
        stderr.write(`Entity not found for id: ${id}\n`)
        return 1
      }
      if (parsed.opts.jsonOutput) writeJson(stdout, entity, true)
      else writeJson(stdout, entity, false)
      return 0
    }

    const init = {
      method: command.method,
      headers,
      signal: AbortSignal.timeout(parsed.opts.timeoutMs),
    }

    if (command.requestType === 'upload') {
      const uploadPath = parsed.opts.file || routeInfo.remaining[0]
      if (!uploadPath) {
        throw new Error(`Missing file path. Usage: ${parsed.group} ${parsed.action} <filePath>`) }

      const resolvedUploadPath = path.isAbsolute(uploadPath) ? uploadPath : path.join(cwd, uploadPath)
      const fileBuffer = fs.readFileSync(resolvedUploadPath)
      const filename = parsed.opts.filename || path.basename(resolvedUploadPath)
      init.body = fileBuffer
      init.headers['x-filename'] = filename
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/octet-stream'
    } else if (command.method !== 'GET' && command.method !== 'HEAD') {
      let body = undefined
      if (parsed.opts.data) {
        body = parseDataInput(parsed.opts.data, stdin)
      }

      if (!isPlainObject(body) && command.expectsJsonBody) {
        body = {}
      }

      if (command.defaultBody) {
        body = { ...(command.defaultBody || {}), ...(isPlainObject(body) ? body : {}) }
      }

      if (command.bodyFlagMap) {
        const mapped = {}
        for (const [flagName, bodyKey] of Object.entries(command.bodyFlagMap)) {
          const val = parsed.opts[flagName]
          if (val !== undefined && val !== '') {
            mapped[bodyKey] = val
          }
        }
        body = { ...(isPlainObject(body) ? body : {}), ...mapped }
      }

      if (body !== undefined) {
        init.body = JSON.stringify(body)
        init.headers['Content-Type'] = 'application/json'
      }
    }

    const res = await fetchImpl(url, init)
    const parsedResponse = await parseResponse(res, command.responseType)

    if (!res.ok) {
      const serialized = serializePayload(parsedResponse.value)
      stderr.write(`Request failed (${res.status} ${res.statusText}): ${serialized}\n`)
      return 1
    }

    if (parsedResponse.type === 'sse') {
      await consumeSse(parsedResponse.value, stdout, stderr, parsed.opts.jsonOutput)
      return 0
    }

    if (parsedResponse.type === 'binary') {
      writeBinary(stdout, stderr, parsedResponse.value, parsed.opts.out, cwd)
      return 0
    }

    if (parsedResponse.type === 'json') {
      if (parsed.opts.jsonOutput) writeJson(stdout, parsedResponse.value, true)
      else writeJson(stdout, parsedResponse.value, false)

      if (parsed.opts.wait) {
        const waitMeta = getWaitId(parsedResponse.value, command)
        if (waitMeta) {
          await waitForEntity({
            entityType: waitMeta.type,
            entityId: waitMeta.id,
            fetchImpl,
            baseUrl,
            headers,
            timeoutMs: parsed.opts.timeoutMs,
            intervalMs: parsed.opts.intervalMs,
            stdout,
            jsonOutput: parsed.opts.jsonOutput,
          })
        } else {
          stderr.write('--wait requested, but response did not include runId/taskId\n')
        }
      }
      return 0
    }

    writeText(stdout, parsedResponse.value)
    return 0
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function extractById(payload, id) {
  if (!id) return null

  if (Array.isArray(payload)) {
    return payload.find((entry) => entry && String(entry.id) === String(id)) || null
  }

  if (isPlainObject(payload)) {
    if (payload[id]) return payload[id]
    if (Array.isArray(payload.items)) {
      return payload.items.find((entry) => entry && String(entry.id) === String(id)) || null
    }
  }

  return null
}

function getApiCoveragePairs() {
  return COMMANDS
    .filter((command) => !command.virtual)
    .map((command) => `${command.method} ${command.route}`)
}

module.exports = {
  COMMAND_GROUPS,
  COMMANDS,
  parseArgv,
  runCli,
  getCommand,
  getApiCoveragePairs,
  buildApiUrl,
  extractPathParams,
  resolveGroup,
  renderGeneralHelp,
  renderGroupHelp,
}
