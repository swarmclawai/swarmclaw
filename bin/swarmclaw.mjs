#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_BASE_URL =
  process.env.SWARMCLAW_URL
  || process.env.SWARMCLAW_BASE_URL
  || 'http://localhost:3456'

const DEFAULT_ACCESS_KEY = process.env.SWARMCLAW_ACCESS_KEY || ''

const GLOBAL_FLAG_KEYS = new Set([
  'url',
  'key',
  'raw',
  'json',
  'file',
  'help',
])

const SHORT_FLAG_ALIASES = {
  h: 'help',
  u: 'url',
  k: 'key',
  r: 'raw',
  j: 'json',
  f: 'file',
}

const GROUP_ALIASES = {
  agent: 'agents',
  session: 'sessions',
  task: 'tasks',
  schedule: 'schedules',
  connector: 'connectors',
  provider: 'providers',
  credential: 'credentials',
  secret: 'secrets',
  skill: 'skills',
  run: 'runs',
  log: 'logs',
  plugin: 'plugins',
}

const DEFAULT_ACTION_ALIASES = {
  ls: 'list',
  del: 'delete',
  rm: 'delete',
}

function appendFlagValue(flags, key, value) {
  if (flags[key] === undefined) {
    flags[key] = value
    return
  }
  if (Array.isArray(flags[key])) {
    flags[key].push(value)
    return
  }
  flags[key] = [flags[key], value]
}

function parseArgv(argv) {
  const flags = {}
  const positionals = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        appendFlagValue(flags, arg.slice(2, eq), arg.slice(eq + 1))
        continue
      }
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        appendFlagValue(flags, key, next)
        i += 1
      } else {
        appendFlagValue(flags, key, true)
      }
      continue
    }

    if (/^-[a-zA-Z]$/.test(arg)) {
      const short = arg.slice(1)
      const key = SHORT_FLAG_ALIASES[short] || short
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        appendFlagValue(flags, key, next)
        i += 1
      } else {
        appendFlagValue(flags, key, true)
      }
      continue
    }

    if (/^-[a-zA-Z]=/.test(arg)) {
      const short = arg[1]
      const key = SHORT_FLAG_ALIASES[short] || short
      appendFlagValue(flags, key, arg.slice(3))
      continue
    }

    positionals.push(arg)
  }

  return { flags, positionals }
}

function getFlag(flags, key) {
  const value = flags[key]
  if (Array.isArray(value)) return value[value.length - 1]
  return value
}

function toBoolean(value, label) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  }
  throw new Error(`Invalid boolean for "${label}": ${String(value)}`)
}

function toOptionalBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  }
  return Boolean(value)
}

function toInteger(value, label) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer for "${label}": ${String(value)}`)
  return parsed
}

function toCamelCase(input) {
  return input.replace(/-([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
}

function coerceValue(value) {
  if (Array.isArray(value)) return value.map(coerceValue)
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonString(value, label) {
  try {
    return JSON.parse(value)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON in ${label}: ${msg}`)
  }
}

function parseJsonFile(filePath) {
  const resolved = path.resolve(process.cwd(), String(filePath))
  const text = fs.readFileSync(resolved, 'utf8')
  return parseJsonString(text, `file ${resolved}`)
}

function buildBodyFromFlags(flags, reservedKeys = []) {
  const reserved = new Set([...GLOBAL_FLAG_KEYS, ...reservedKeys])
  const body = {}

  for (const [rawKey, rawValue] of Object.entries(flags)) {
    if (reserved.has(rawKey)) continue
    body[toCamelCase(rawKey)] = coerceValue(rawValue)
  }

  return body
}

function parseBody(flags, reservedKeys = [], opts = {}) {
  const { allowEmpty = true } = opts
  const derived = buildBodyFromFlags(flags, reservedKeys)

  const explicitBodies = []
  const fileValue = getFlag(flags, 'file')
  const jsonValue = getFlag(flags, 'json')

  if (fileValue !== undefined) {
    explicitBodies.push(parseJsonFile(fileValue))
  }
  if (jsonValue !== undefined) {
    explicitBodies.push(parseJsonString(String(jsonValue), '--json'))
  }

  if (explicitBodies.length === 0) {
    if (!allowEmpty && Object.keys(derived).length === 0) {
      throw new Error('No payload provided. Use --json, --file, or explicit flags.')
    }
    return derived
  }

  let explicit = {}
  for (const item of explicitBodies) {
    if (!isPlainObject(item)) {
      if (Object.keys(derived).length > 0 || explicitBodies.length > 1) {
        throw new Error('Non-object JSON payload cannot be merged with flag-based payload.')
      }
      return item
    }
    explicit = { ...explicit, ...item }
  }

  const merged = { ...derived, ...explicit }
  if (!allowEmpty && Object.keys(merged).length === 0) {
    throw new Error('No payload provided. Use --json, --file, or explicit flags.')
  }
  return merged
}

function parseCsvList(value) {
  if (value === undefined) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseCsvList(item))
  }
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseIdList(value, fallback = []) {
  const fromFlag = parseCsvList(value)
  if (fromFlag.length) return fromFlag
  return fallback.filter(Boolean)
}

function requireArg(args, index, label) {
  const value = args[index]
  if (!value) throw new Error(`Missing ${label}`)
  return value
}

function pickById(record, id, label) {
  if (!record || typeof record !== 'object') {
    throw new Error(`Unexpected ${label} response format.`)
  }
  const item = record[id]
  if (!item) throw new Error(`${label} "${id}" not found.`)
  return item
}

function resolveGroupName(rawName) {
  return GROUP_ALIASES[rawName] || rawName
}

function resolveCommandName(groupDef, rawName) {
  if (!rawName) return rawName
  const aliases = {
    ...DEFAULT_ACTION_ALIASES,
    ...(groupDef.aliases || {}),
  }
  return aliases[rawName] || rawName
}

function buildApiUrl(baseUrl, apiPath, query) {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  const url = new URL(`${normalizedBase}/api${normalizedPath}`)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== '') {
            url.searchParams.append(key, String(item))
          }
        }
      } else {
        url.searchParams.set(key, String(value))
      }
    }
  }

  return url.toString()
}

function parseResponsePayload(text, contentType) {
  if (!text) return null
  if ((contentType || '').includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function formatHttpError(status, payload) {
  if (payload && typeof payload === 'object') {
    const err = payload.error || payload.message
    if (err) return `HTTP ${status}: ${String(err)}`
    return `HTTP ${status}: ${JSON.stringify(payload)}`
  }
  if (typeof payload === 'string' && payload.trim()) {
    return `HTTP ${status}: ${payload.trim()}`
  }
  return `HTTP ${status}`
}

async function request(ctx, method, apiPath, options = {}) {
  const {
    query,
    body,
    headers = {},
    rawBody = false,
    stream = false,
  } = options

  const reqHeaders = { ...headers }
  if (ctx.accessKey) reqHeaders['X-Access-Key'] = ctx.accessKey

  let reqBody
  if (body !== undefined) {
    if (rawBody) {
      reqBody = body
    } else {
      reqHeaders['Content-Type'] = 'application/json'
      reqBody = JSON.stringify(body)
    }
  }

  const url = buildApiUrl(ctx.baseUrl, apiPath, query)
  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  })

  if (stream) {
    if (!res.ok) {
      const text = await res.text()
      const payload = parseResponsePayload(text, res.headers.get('content-type') || '')
      throw new Error(formatHttpError(res.status, payload))
    }
    return res
  }

  const text = await res.text()
  const payload = parseResponsePayload(text, res.headers.get('content-type') || '')
  if (!res.ok) throw new Error(formatHttpError(res.status, payload))
  return payload
}

function printResult(ctx, value) {
  if (ctx.raw && typeof value === 'string') {
    process.stdout.write(value)
    if (!value.endsWith('\n')) process.stdout.write('\n')
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printChatEvent(event, rawMode) {
  if (rawMode) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }

  const type = event?.t
  if ((type === 'd' || type === 'r') && typeof event.text === 'string') {
    process.stdout.write(event.text)
    return
  }

  if (type === 'md' && typeof event.text === 'string') {
    try {
      const parsed = JSON.parse(event.text)
      if (parsed?.run?.id) {
        const parts = [
          `id=${parsed.run.id}`,
          `status=${parsed.run.status || 'unknown'}`,
        ]
        if (parsed.run.position !== undefined) {
          parts.push(`position=${parsed.run.position}`)
        }
        process.stderr.write(`\n[run] ${parts.join(' ')}\n`)
        return
      }
    } catch {
      // fall through and print metadata text
    }
    process.stderr.write(`\n[meta] ${event.text}\n`)
    return
  }

  if (type === 'tool_call') {
    process.stderr.write(
      `\n[tool:call] ${event.toolName || ''}${event.toolInput ? ` ${event.toolInput}` : ''}\n`,
    )
    return
  }

  if (type === 'tool_result') {
    process.stderr.write(
      `\n[tool:result] ${event.toolName || ''}${event.toolOutput ? ` ${event.toolOutput}` : ''}\n`,
    )
    return
  }

  if (type === 'err') {
    process.stderr.write(`\n[error] ${event.text || 'Unknown error'}\n`)
    return
  }
}

function parseSseBlock(block) {
  const lines = block.replace(/\r\n/g, '\n').split('\n')
  const dataLines = []
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (!dataLines.length) return null
  const raw = dataLines.join('\n')
  try {
    return JSON.parse(raw)
  } catch {
    return { t: 'raw', text: raw }
  }
}

async function consumeSseStream(stream, onEvent) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = parseSseBlock(chunk)
      if (event) onEvent(event)
      boundary = buffer.indexOf('\n\n')
    }
  }

  const tail = buffer.trim()
  if (tail) {
    const event = parseSseBlock(tail)
    if (event) onEvent(event)
  }
}

async function runSessionChat(ctx, sessionId, body) {
  const response = await request(ctx, 'POST', `/sessions/${encodeURIComponent(sessionId)}/chat`, {
    body,
    stream: true,
  })

  if (!response.body) throw new Error('Chat stream did not return a response body.')
  await consumeSseStream(response.body, (event) => printChatEvent(event, ctx.raw))
  if (!ctx.raw) process.stdout.write('\n')
}

function createContext(flags) {
  const rawFlag = getFlag(flags, 'raw')
  return {
    baseUrl: String(getFlag(flags, 'url') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    accessKey: String(getFlag(flags, 'key') || DEFAULT_ACCESS_KEY),
    raw: toOptionalBoolean(rawFlag, false),
  }
}

const GROUPS = {
  auth: {
    description: 'Access key bootstrap/auth checks',
    commands: {
      status: {
        summary: 'Check auth setup status',
        usage: 'auth status',
        run: async ({ ctx }) => {
          const data = await request({ ...ctx, accessKey: '' }, 'GET', '/auth')
          printResult(ctx, data)
        },
      },
      login: {
        summary: 'Validate an access key',
        usage: 'auth login --key <ACCESS_KEY> | auth login <ACCESS_KEY>',
        run: async ({ ctx, args, flags }) => {
          const key = String(getFlag(flags, 'key') || args[0] || '')
          if (!key) throw new Error('Missing key. Use auth login --key <ACCESS_KEY>.')
          const data = await request({ ...ctx, accessKey: '' }, 'POST', '/auth', { body: { key } })
          printResult(ctx, data)
        },
      },
    },
  },
  agents: {
    description: 'Manage agents',
    commands: {
      list: {
        summary: 'List agents',
        usage: 'agents list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/agents')),
      },
      get: {
        summary: 'Get one agent by id',
        usage: 'agents get <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'agent id')
          const all = await request(ctx, 'GET', '/agents')
          printResult(ctx, pickById(all, id, 'Agent'))
        },
      },
      create: {
        summary: 'Create an agent',
        usage: 'agents create --name "Agent" --provider openai --model gpt-4o',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/agents', { body }))
        },
      },
      update: {
        summary: 'Update an agent',
        usage: 'agents update <id> --name "New Name"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'agent id')
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', `/agents/${encodeURIComponent(id)}`, { body }))
        },
      },
      delete: {
        summary: 'Delete an agent',
        usage: 'agents delete <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'agent id')
          printResult(ctx, await request(ctx, 'DELETE', `/agents/${encodeURIComponent(id)}`))
        },
      },
    },
  },
  sessions: {
    description: 'Manage sessions and session actions',
    aliases: { send: 'chat' },
    commands: {
      list: {
        summary: 'List sessions',
        usage: 'sessions list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/sessions')),
      },
      get: {
        summary: 'Get one session by id',
        usage: 'sessions get <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          const all = await request(ctx, 'GET', '/sessions')
          printResult(ctx, pickById(all, id, 'Session'))
        },
      },
      create: {
        summary: 'Create a session',
        usage: 'sessions create --name "My Session" --cwd ~/Dev --provider claude-cli',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/sessions', { body }))
        },
      },
      update: {
        summary: 'Update a session',
        usage: 'sessions update <id> --name "Renamed Session"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'session id')
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', `/sessions/${encodeURIComponent(id)}`, { body }))
        },
      },
      delete: {
        summary: 'Delete one session',
        usage: 'sessions delete <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          printResult(ctx, await request(ctx, 'DELETE', `/sessions/${encodeURIComponent(id)}`))
        },
      },
      'delete-many': {
        summary: 'Delete multiple sessions',
        usage: 'sessions delete-many --ids id1,id2,id3',
        run: async ({ ctx, args, flags }) => {
          const ids = parseIdList(getFlag(flags, 'ids'), args)
          if (!ids.length) throw new Error('Missing ids. Use --ids id1,id2 or pass ids as args.')
          printResult(ctx, await request(ctx, 'DELETE', '/sessions', { body: { ids } }))
        },
      },
      clear: {
        summary: 'Clear session messages and resume ids',
        usage: 'sessions clear <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          printResult(ctx, await request(ctx, 'POST', `/sessions/${encodeURIComponent(id)}/clear`))
        },
      },
      stop: {
        summary: 'Stop active/queued runs in a session',
        usage: 'sessions stop <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          printResult(ctx, await request(ctx, 'POST', `/sessions/${encodeURIComponent(id)}/stop`))
        },
      },
      messages: {
        summary: 'Get session messages',
        usage: 'sessions messages <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          printResult(ctx, await request(ctx, 'GET', `/sessions/${encodeURIComponent(id)}/messages`))
        },
      },
      chat: {
        summary: 'Send chat message (streams response)',
        usage: 'sessions chat <id> --message "Implement X"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'session id')
          const message = String(getFlag(flags, 'message') || args.slice(1).join(' ')).trim()
          if (!message) throw new Error('Missing message. Use --message or pass it after the session id.')

          const body = { message }
          const imagePath = getFlag(flags, 'image-path')
          const imageUrl = getFlag(flags, 'image-url')
          const internal = getFlag(flags, 'internal')
          const queueMode = getFlag(flags, 'queue-mode')
          if (imagePath !== undefined) body.imagePath = String(imagePath)
          if (imageUrl !== undefined) body.imageUrl = String(imageUrl)
          if (internal !== undefined) body.internal = toBoolean(internal, 'internal')
          if (queueMode !== undefined) body.queueMode = String(queueMode)

          await runSessionChat(ctx, id, body)
        },
      },
      browser: {
        summary: 'Get browser active state for a session',
        usage: 'sessions browser <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          printResult(ctx, await request(ctx, 'GET', `/sessions/${encodeURIComponent(id)}/browser`))
        },
      },
      'browser-clear': {
        summary: 'Cleanup/close browser state for a session',
        usage: 'sessions browser-clear <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'session id')
          printResult(ctx, await request(ctx, 'DELETE', `/sessions/${encodeURIComponent(id)}/browser`))
        },
      },
      devserver: {
        summary: 'Control session dev server',
        usage: 'sessions devserver <id> --action start|stop|status',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'session id')
          const action = String(getFlag(flags, 'action') || args[1] || '').trim()
          if (!action) throw new Error('Missing action. Use --action start|stop|status.')
          printResult(
            ctx,
            await request(ctx, 'POST', `/sessions/${encodeURIComponent(id)}/devserver`, {
              body: { action },
            }),
          )
        },
      },
      deploy: {
        summary: 'Commit and push session cwd',
        usage: 'sessions deploy <id> --message "Deploy from CLI"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'session id')
          const message = String(getFlag(flags, 'message') || 'Deploy from SwarmClaw CLI')
          printResult(
            ctx,
            await request(ctx, 'POST', `/sessions/${encodeURIComponent(id)}/deploy`, {
              body: { message },
            }),
          )
        },
      },
    },
  },
  tasks: {
    description: 'Manage task board tasks',
    commands: {
      list: {
        summary: 'List tasks',
        usage: 'tasks list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/tasks')),
      },
      get: {
        summary: 'Get task by id',
        usage: 'tasks get <id>',
        run: async ({ ctx, args }) => printResult(ctx, await request(ctx, 'GET', `/tasks/${encodeURIComponent(requireArg(args, 0, 'task id'))}`)),
      },
      create: {
        summary: 'Create a task',
        usage: 'tasks create --title "Fix bug" --agent-id <agentId>',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/tasks', { body }))
        },
      },
      update: {
        summary: 'Update a task',
        usage: 'tasks update <id> --status queued',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'task id')
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', `/tasks/${encodeURIComponent(id)}`, { body }))
        },
      },
      delete: {
        summary: 'Delete a task',
        usage: 'tasks delete <id>',
        run: async ({ ctx, args }) => printResult(ctx, await request(ctx, 'DELETE', `/tasks/${encodeURIComponent(requireArg(args, 0, 'task id'))}`)),
      },
      queue: {
        summary: 'Queue a task immediately',
        usage: 'tasks queue <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'task id')
          printResult(ctx, await request(ctx, 'PUT', `/tasks/${encodeURIComponent(id)}`, { body: { status: 'queued' } }))
        },
      },
      comment: {
        summary: 'Append comment to a task',
        usage: 'tasks comment <id> --text "Progress update" [--author user] [--agent-id <id>]',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'task id')
          const text = String(getFlag(flags, 'text') || args.slice(1).join(' ')).trim()
          if (!text) throw new Error('Missing comment text. Use --text "..."')
          const comment = {
            id: crypto.randomBytes(4).toString('hex'),
            author: String(getFlag(flags, 'author') || 'user'),
            text,
            createdAt: Date.now(),
          }
          const agentId = getFlag(flags, 'agent-id')
          if (agentId !== undefined) comment.agentId = String(agentId)
          printResult(
            ctx,
            await request(ctx, 'PUT', `/tasks/${encodeURIComponent(id)}`, {
              body: { appendComment: comment },
            }),
          )
        },
      },
    },
  },
  schedules: {
    description: 'Manage schedules',
    commands: {
      list: {
        summary: 'List schedules',
        usage: 'schedules list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/schedules')),
      },
      get: {
        summary: 'Get schedule by id',
        usage: 'schedules get <id>',
        run: async ({ ctx, args }) => {
          const all = await request(ctx, 'GET', '/schedules')
          printResult(ctx, pickById(all, requireArg(args, 0, 'schedule id'), 'Schedule'))
        },
      },
      create: {
        summary: 'Create a schedule',
        usage: 'schedules create --name "Daily" --agent-id <id> --schedule-type cron --cron "0 * * * *"',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/schedules', { body }))
        },
      },
      update: {
        summary: 'Update a schedule',
        usage: 'schedules update <id> --status paused',
        run: async ({ ctx, args, flags }) => {
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(
            ctx,
            await request(ctx, 'PUT', `/schedules/${encodeURIComponent(requireArg(args, 0, 'schedule id'))}`, {
              body,
            }),
          )
        },
      },
      delete: {
        summary: 'Delete a schedule',
        usage: 'schedules delete <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'DELETE', `/schedules/${encodeURIComponent(requireArg(args, 0, 'schedule id'))}`))
        },
      },
      run: {
        summary: 'Run a schedule immediately',
        usage: 'schedules run <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'POST', `/schedules/${encodeURIComponent(requireArg(args, 0, 'schedule id'))}/run`))
        },
      },
    },
  },
  memory: {
    description: 'Manage memory entries',
    aliases: { find: 'search' },
    commands: {
      list: {
        summary: 'List memory entries',
        usage: 'memory list [--agent-id <id>]',
        run: async ({ ctx, flags }) => {
          const agentId = getFlag(flags, 'agent-id')
          printResult(
            ctx,
            await request(ctx, 'GET', '/memory', {
              query: { agentId },
            }),
          )
        },
      },
      search: {
        summary: 'Search memory',
        usage: 'memory search --q "topic" [--agent-id <id>]',
        run: async ({ ctx, args, flags }) => {
          const q = String(getFlag(flags, 'q') || getFlag(flags, 'query') || args.join(' ')).trim()
          if (!q) throw new Error('Missing search query. Use --q "..."')
          const agentId = getFlag(flags, 'agent-id')
          printResult(
            ctx,
            await request(ctx, 'GET', '/memory', {
              query: { q, agentId },
            }),
          )
        },
      },
      create: {
        summary: 'Create memory entry',
        usage: 'memory create --title "Note" --content "..." --category note',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/memory', { body }))
        },
      },
      update: {
        summary: 'Update memory entry',
        usage: 'memory update <id> --title "Updated"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'memory id')
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', `/memory/${encodeURIComponent(id)}`, { body }))
        },
      },
      delete: {
        summary: 'Delete memory entry',
        usage: 'memory delete <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'memory id')
          printResult(ctx, await request(ctx, 'DELETE', `/memory/${encodeURIComponent(id)}`))
        },
      },
    },
  },
  connectors: {
    description: 'Manage chat connectors',
    commands: {
      list: {
        summary: 'List connectors',
        usage: 'connectors list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/connectors')),
      },
      get: {
        summary: 'Get connector by id',
        usage: 'connectors get <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'GET', `/connectors/${encodeURIComponent(requireArg(args, 0, 'connector id'))}`))
        },
      },
      create: {
        summary: 'Create connector',
        usage: 'connectors create --platform telegram --agent-id <id> --name "My Bot"',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/connectors', { body }))
        },
      },
      update: {
        summary: 'Update connector',
        usage: 'connectors update <id> --name "Renamed"',
        run: async ({ ctx, args, flags }) => {
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(
            ctx,
            await request(ctx, 'PUT', `/connectors/${encodeURIComponent(requireArg(args, 0, 'connector id'))}`, { body }),
          )
        },
      },
      delete: {
        summary: 'Delete connector',
        usage: 'connectors delete <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'DELETE', `/connectors/${encodeURIComponent(requireArg(args, 0, 'connector id'))}`))
        },
      },
      start: {
        summary: 'Start connector',
        usage: 'connectors start <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'connector id')
          printResult(ctx, await request(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, { body: { action: 'start' } }))
        },
      },
      stop: {
        summary: 'Stop connector',
        usage: 'connectors stop <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'connector id')
          printResult(ctx, await request(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, { body: { action: 'stop' } }))
        },
      },
      repair: {
        summary: 'Repair connector',
        usage: 'connectors repair <id>',
        run: async ({ ctx, args }) => {
          const id = requireArg(args, 0, 'connector id')
          printResult(ctx, await request(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, { body: { action: 'repair' } }))
        },
      },
    },
  },
  providers: {
    description: 'Provider and model config operations',
    commands: {
      list: {
        summary: 'List full provider registry',
        usage: 'providers list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/providers')),
      },
      configs: {
        summary: 'List provider configs',
        usage: 'providers configs',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/providers/configs')),
      },
      'config-get': {
        summary: 'Get one provider config',
        usage: 'providers config-get <id>',
        run: async ({ ctx, args }) => printResult(ctx, await request(ctx, 'GET', `/providers/${encodeURIComponent(requireArg(args, 0, 'provider id'))}`)),
      },
      'config-create': {
        summary: 'Create custom provider config',
        usage: 'providers config-create --name "My API" --base-url https://...',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags)
          printResult(ctx, await request(ctx, 'POST', '/providers', { body }))
        },
      },
      'config-update': {
        summary: 'Update provider config',
        usage: 'providers config-update <id> --name "New Name"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'provider id')
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', `/providers/${encodeURIComponent(id)}`, { body }))
        },
      },
      'config-delete': {
        summary: 'Delete custom provider config',
        usage: 'providers config-delete <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'DELETE', `/providers/${encodeURIComponent(requireArg(args, 0, 'provider id'))}`))
        },
      },
      'models-get': {
        summary: 'Get provider model list/override state',
        usage: 'providers models-get <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'GET', `/providers/${encodeURIComponent(requireArg(args, 0, 'provider id'))}/models`))
        },
      },
      'models-set': {
        summary: 'Override provider models',
        usage: 'providers models-set <id> --models modelA,modelB',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'provider id')
          const fromFlag = parseCsvList(getFlag(flags, 'models'))
          const baseBody = parseBody(flags, ['models'])
          const models = fromFlag.length ? fromFlag : baseBody.models
          if (!Array.isArray(models) || models.length === 0) {
            throw new Error('Missing models. Use --models a,b or --json \'{"models":["a","b"]}\'.')
          }
          printResult(
            ctx,
            await request(ctx, 'PUT', `/providers/${encodeURIComponent(id)}/models`, {
              body: { ...baseBody, models },
            }),
          )
        },
      },
      'models-reset': {
        summary: 'Remove provider model override',
        usage: 'providers models-reset <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'DELETE', `/providers/${encodeURIComponent(requireArg(args, 0, 'provider id'))}/models`))
        },
      },
      ollama: {
        summary: 'List models from an Ollama endpoint',
        usage: 'providers ollama [--endpoint http://localhost:11434]',
        run: async ({ ctx, flags }) => {
          printResult(
            ctx,
            await request(ctx, 'GET', '/providers/ollama', {
              query: { endpoint: getFlag(flags, 'endpoint') },
            }),
          )
        },
      },
    },
  },
  credentials: {
    description: 'Manage provider credentials',
    commands: {
      list: {
        summary: 'List credentials metadata',
        usage: 'credentials list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/credentials')),
      },
      create: {
        summary: 'Create credential',
        usage: 'credentials create --provider openai --api-key sk-... [--name "OpenAI Key"]',
        run: async ({ ctx, args, flags }) => {
          const provider = String(getFlag(flags, 'provider') || args[0] || '').trim()
          const apiKey = String(getFlag(flags, 'api-key') || '').trim()
          const name = getFlag(flags, 'name')
          if (!provider) throw new Error('Missing provider. Use --provider <id>.')
          if (!apiKey) throw new Error('Missing API key. Use --api-key <key>.')
          printResult(
            ctx,
            await request(ctx, 'POST', '/credentials', {
              body: {
                provider,
                apiKey,
                ...(name !== undefined ? { name: String(name) } : {}),
              },
            }),
          )
        },
      },
      delete: {
        summary: 'Delete credential',
        usage: 'credentials delete <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'DELETE', `/credentials/${encodeURIComponent(requireArg(args, 0, 'credential id'))}`))
        },
      },
    },
  },
  secrets: {
    description: 'Manage encrypted orchestrator secrets',
    commands: {
      list: {
        summary: 'List secrets metadata',
        usage: 'secrets list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/secrets')),
      },
      create: {
        summary: 'Create secret',
        usage: 'secrets create --name "Gmail" --service gmail --value "..."',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'POST', '/secrets', { body }))
        },
      },
      update: {
        summary: 'Update secret metadata',
        usage: 'secrets update <id> --name "Updated"',
        run: async ({ ctx, args, flags }) => {
          const id = requireArg(args, 0, 'secret id')
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', `/secrets/${encodeURIComponent(id)}`, { body }))
        },
      },
      delete: {
        summary: 'Delete secret',
        usage: 'secrets delete <id>',
        run: async ({ ctx, args }) => {
          printResult(ctx, await request(ctx, 'DELETE', `/secrets/${encodeURIComponent(requireArg(args, 0, 'secret id'))}`))
        },
      },
    },
  },
  skills: {
    description: 'Manage skills',
    commands: {
      list: {
        summary: 'List skills',
        usage: 'skills list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/skills')),
      },
      get: {
        summary: 'Get skill by id',
        usage: 'skills get <id>',
        run: async ({ ctx, args }) => printResult(ctx, await request(ctx, 'GET', `/skills/${encodeURIComponent(requireArg(args, 0, 'skill id'))}`)),
      },
      create: {
        summary: 'Create skill',
        usage: 'skills create --name "Skill" --content "...markdown..."',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'POST', '/skills', { body }))
        },
      },
      update: {
        summary: 'Update skill',
        usage: 'skills update <id> --name "Updated Name"',
        run: async ({ ctx, args, flags }) => {
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(
            ctx,
            await request(ctx, 'PUT', `/skills/${encodeURIComponent(requireArg(args, 0, 'skill id'))}`, {
              body,
            }),
          )
        },
      },
      delete: {
        summary: 'Delete skill',
        usage: 'skills delete <id>',
        run: async ({ ctx, args }) => printResult(ctx, await request(ctx, 'DELETE', `/skills/${encodeURIComponent(requireArg(args, 0, 'skill id'))}`)),
      },
      import: {
        summary: 'Import skill from URL',
        usage: 'skills import --url https://.../SKILL.md',
        run: async ({ ctx, args, flags }) => {
          const url = String(getFlag(flags, 'url') || args[0] || '').trim()
          if (!url) throw new Error('Missing url. Use --url https://...')
          const body = parseBody(flags, ['url'])
          printResult(ctx, await request(ctx, 'POST', '/skills/import', { body: { ...body, url } }))
        },
      },
    },
  },
  settings: {
    description: 'Manage app settings',
    commands: {
      get: {
        summary: 'Get settings',
        usage: 'settings get',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/settings')),
      },
      set: {
        summary: 'Update settings',
        usage: 'settings set --json \'{"loopMode":"bounded"}\'',
        run: async ({ ctx, flags }) => {
          const body = parseBody(flags, [], { allowEmpty: false })
          printResult(ctx, await request(ctx, 'PUT', '/settings', { body }))
        },
      },
    },
  },
  daemon: {
    description: 'Control background daemon',
    commands: {
      status: {
        summary: 'Get daemon status',
        usage: 'daemon status',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/daemon')),
      },
      start: {
        summary: 'Start daemon',
        usage: 'daemon start',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'POST', '/daemon', { body: { action: 'start' } })),
      },
      stop: {
        summary: 'Stop daemon',
        usage: 'daemon stop',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'POST', '/daemon', { body: { action: 'stop' } })),
      },
    },
  },
  runs: {
    description: 'Inspect session run queue state',
    commands: {
      list: {
        summary: 'List runs',
        usage: 'runs list [--session-id <id>] [--status queued] [--limit 50]',
        run: async ({ ctx, flags }) => {
          const limit = getFlag(flags, 'limit')
          printResult(
            ctx,
            await request(ctx, 'GET', '/runs', {
              query: {
                sessionId: getFlag(flags, 'session-id'),
                status: getFlag(flags, 'status'),
                limit: limit !== undefined ? toInteger(limit, 'limit') : undefined,
              },
            }),
          )
        },
      },
      get: {
        summary: 'Get run by id',
        usage: 'runs get <id>',
        run: async ({ ctx, args }) => printResult(ctx, await request(ctx, 'GET', `/runs/${encodeURIComponent(requireArg(args, 0, 'run id'))}`)),
      },
    },
  },
  logs: {
    description: 'Query/clear server logs',
    commands: {
      list: {
        summary: 'List logs',
        usage: 'logs list [--lines 200] [--level INFO,ERROR] [--search "term"]',
        run: async ({ ctx, flags }) => {
          const lines = getFlag(flags, 'lines')
          printResult(
            ctx,
            await request(ctx, 'GET', '/logs', {
              query: {
                lines: lines !== undefined ? toInteger(lines, 'lines') : undefined,
                level: getFlag(flags, 'level'),
                search: getFlag(flags, 'search'),
              },
            }),
          )
        },
      },
      clear: {
        summary: 'Clear log file',
        usage: 'logs clear',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'DELETE', '/logs')),
      },
    },
  },
  plugins: {
    description: 'Manage plugins',
    commands: {
      list: {
        summary: 'List plugins',
        usage: 'plugins list',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/plugins')),
      },
      set: {
        summary: 'Enable/disable plugin',
        usage: 'plugins set <filename> --enabled true|false',
        run: async ({ ctx, args, flags }) => {
          const filename = String(requireArg(args, 0, 'plugin filename'))
          const enabledRaw = getFlag(flags, 'enabled')
          if (enabledRaw === undefined) throw new Error('Missing --enabled true|false')
          const enabled = toBoolean(enabledRaw, 'enabled')
          printResult(ctx, await request(ctx, 'POST', '/plugins', { body: { filename, enabled } }))
        },
      },
      marketplace: {
        summary: 'Fetch plugin marketplace registry',
        usage: 'plugins marketplace',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/plugins/marketplace')),
      },
      install: {
        summary: 'Install plugin from HTTPS URL',
        usage: 'plugins install --url https://... --filename my-plugin.js',
        run: async ({ ctx, args, flags }) => {
          const url = String(getFlag(flags, 'url') || args[0] || '').trim()
          const filename = String(getFlag(flags, 'filename') || args[1] || '').trim()
          if (!url) throw new Error('Missing --url')
          if (!filename) throw new Error('Missing --filename')
          printResult(ctx, await request(ctx, 'POST', '/plugins/install', { body: { url, filename } }))
        },
      },
    },
  },
  usage: {
    description: 'Usage/cost summary',
    commands: {
      summary: {
        summary: 'Get usage summary',
        usage: 'usage summary',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/usage')),
      },
    },
  },
  version: {
    description: 'Version/update endpoints',
    commands: {
      check: {
        summary: 'Check local vs remote version',
        usage: 'version check',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'GET', '/version')),
      },
      update: {
        summary: 'Pull latest from origin/main',
        usage: 'version update',
        run: async ({ ctx }) => printResult(ctx, await request(ctx, 'POST', '/version/update')),
      },
    },
  },
  orchestrator: {
    description: 'Trigger orchestrator run as task',
    commands: {
      run: {
        summary: 'Create+queue task for orchestrator',
        usage: 'orchestrator run --agent-id <id> --task "Do work"',
        run: async ({ ctx, flags, args }) => {
          const agentId = String(getFlag(flags, 'agent-id') || '').trim()
          const task = String(getFlag(flags, 'task') || args.join(' ')).trim()
          if (!agentId) throw new Error('Missing --agent-id')
          if (!task) throw new Error('Missing --task "..."')
          printResult(ctx, await request(ctx, 'POST', '/orchestrator/run', { body: { agentId, task } }))
        },
      },
    },
  },
  dirs: {
    description: 'Directory browser helper endpoints',
    commands: {
      list: {
        summary: 'List directories under a path',
        usage: 'dirs list [--path ~/Dev]',
        run: async ({ ctx, flags }) => {
          printResult(
            ctx,
            await request(ctx, 'GET', '/dirs', {
              query: { path: getFlag(flags, 'path') },
            }),
          )
        },
      },
    },
  },
  upload: {
    description: 'Upload files to /api/uploads',
    commands: {
      file: {
        summary: 'Upload a file',
        usage: 'upload file ./screenshot.png [--filename custom.png]',
        run: async ({ ctx, args, flags }) => {
          const localPath = path.resolve(process.cwd(), requireArg(args, 0, 'local file path'))
          const filename = String(getFlag(flags, 'filename') || path.basename(localPath))
          const buf = fs.readFileSync(localPath)
          printResult(
            ctx,
            await request(ctx, 'POST', '/upload', {
              body: buf,
              rawBody: true,
              headers: {
                'X-Filename': filename,
                'Content-Type': 'application/octet-stream',
              },
            }),
          )
        },
      },
    },
  },
}

function printGlobalHelp() {
  const lines = [
    'SwarmClaw CLI',
    '',
    'Usage:',
    '  swarmclaw <group> <command> [args] [--flags]',
    '  swarmclaw help [group]',
    '',
    'Global Flags:',
    '  --url <baseUrl>      API base URL (default: SWARMCLAW_URL or http://localhost:3456)',
    '  --key <accessKey>    Access key (default: SWARMCLAW_ACCESS_KEY)',
    '  --raw                Print raw text for text endpoints and chat streams',
    '  --json <json>        Inline JSON payload for create/update commands',
    '  --file <path>        JSON payload file for create/update commands',
    '  --help               Show help',
    '',
    'Groups:',
  ]

  for (const [groupName, groupDef] of Object.entries(GROUPS)) {
    lines.push(`  ${groupName.padEnd(14)} ${groupDef.description}`)
  }

  lines.push('', 'Tip: use "swarmclaw help <group>" for group commands.')
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printGroupHelp(groupName) {
  const groupDef = GROUPS[groupName]
  if (!groupDef) {
    throw new Error(`Unknown group "${groupName}"`)
  }

  const lines = [
    `SwarmClaw CLI - ${groupName}`,
    '',
    groupDef.description,
    '',
    'Usage:',
    `  swarmclaw ${groupName} <command> [args] [--flags]`,
    '',
    'Commands:',
  ]

  for (const [commandName, commandDef] of Object.entries(groupDef.commands)) {
    lines.push(`  ${commandName.padEnd(14)} ${commandDef.summary}`)
    if (commandDef.usage) lines.push(`    ${commandDef.usage}`)
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main() {
  const { flags, positionals } = parseArgv(process.argv.slice(2))

  const wantsHelp =
    toOptionalBoolean(getFlag(flags, 'help'), false)
    || positionals[0] === 'help'
    || positionals.length === 0

  if (wantsHelp) {
    const maybeGroup = positionals[0] === 'help'
      ? positionals[1]
      : positionals[0]
    if (maybeGroup) {
      const resolved = resolveGroupName(maybeGroup)
      if (GROUPS[resolved]) {
        printGroupHelp(resolved)
        return
      }
    }
    printGlobalHelp()
    return
  }

  const rawGroup = positionals[0]
  const rawCommand = positionals[1]
  const args = positionals.slice(2)

  const groupName = resolveGroupName(rawGroup)
  const groupDef = GROUPS[groupName]
  if (!groupDef) {
    printGlobalHelp()
    throw new Error(`Unknown group "${rawGroup}"`)
  }

  if (!rawCommand || rawCommand === 'help') {
    printGroupHelp(groupName)
    return
  }

  const commandName = resolveCommandName(groupDef, rawCommand)
  const commandDef = groupDef.commands[commandName]
  if (!commandDef) {
    printGroupHelp(groupName)
    throw new Error(`Unknown command "${rawCommand}" for group "${groupName}"`)
  }

  const ctx = createContext(flags)
  await commandDef.run({ ctx, args, flags })
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
})
