#!/usr/bin/env -S node --experimental-strip-types

import { Command } from 'commander'
import { pathToFileURL } from 'node:url'

interface CliContext {
  baseUrl: string
  accessKey: string
  rawOutput: boolean
}

const DEFAULT_BASE_URL =
  process.env.SWARMCLAW_URL
  || process.env.SWARMCLAW_BASE_URL
  || 'http://localhost:3456'

const DEFAULT_ACCESS_KEY = process.env.SWARMCLAW_ACCESS_KEY || ''

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, '')
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object response`)
  }
  return value as Record<string, unknown>
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

function parseMetadata(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid --metadata JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--metadata must be a JSON object')
  }

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[key] = String(value)
  }
  return out
}

function parseJsonValue(raw: string | undefined, label: string): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid ${label} JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10)

  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp for --run-at: ${raw}`)
  }
  return ms
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value)
  return previous
}

function contextFromCommand(command: Command): CliContext {
  const opts = command.optsWithGlobals<{
    url?: string
    key?: string
    raw?: boolean
  }>()

  return {
    baseUrl: normalizeBaseUrl(opts.url || DEFAULT_BASE_URL),
    accessKey: (opts.key || DEFAULT_ACCESS_KEY).trim(),
    rawOutput: Boolean(opts.raw),
  }
}

function buildApiUrl(ctx: CliContext, routePath: string, query?: URLSearchParams): URL {
  const apiBase = ctx.baseUrl.endsWith('/api') ? ctx.baseUrl : `${ctx.baseUrl}/api`
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`
  const url = new URL(`${apiBase}${normalizedPath}`)
  if (query) {
    query.forEach((value, key) => {
      url.searchParams.set(key, value)
    })
  }
  return url
}

async function apiRequest<T = unknown>(
  ctx: CliContext,
  method: string,
  routePath: string,
  body?: unknown,
  query?: URLSearchParams,
): Promise<T> {
  const url = buildApiUrl(ctx, routePath, query)
  const headers: Record<string, string> = {}

  if (ctx.accessKey) headers['X-Access-Key'] = ctx.accessKey
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  let responseBody: unknown = null

  if (contentType.includes('application/json')) {
    responseBody = await response.json().catch(() => null)
  } else {
    const text = await response.text().catch(() => '')
    responseBody = text.length > 0 ? text : null
  }

  if (!response.ok) {
    const detail = typeof responseBody === 'string'
      ? responseBody
      : JSON.stringify(responseBody)
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${detail}`)
  }

  return responseBody as T
}

function printResult(value: unknown, rawOutput: boolean): void {
  if (value === undefined || value === null) {
    console.log('null')
    return
  }

  if (typeof value === 'string') {
    console.log(value)
    return
  }

  if (rawOutput) {
    process.stdout.write(`${JSON.stringify(value)}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function resolveByIdFromCollection(
  ctx: CliContext,
  routePath: string,
  id: string,
): Promise<unknown> {
  const collection = parseObject(await apiRequest(ctx, 'GET', routePath), routePath)
  if (!(id in collection)) {
    throw new Error(`Not found: ${routePath} id=${id}`)
  }
  return collection[id]
}

async function runWithHandler(command: Command, task: (ctx: CliContext) => Promise<unknown>): Promise<void> {
  try {
    const ctx = contextFromCommand(command)
    const result = await task(ctx)
    printResult(result, ctx.rawOutput)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(msg)
    process.exitCode = 1
  }
}

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('swarmclaw')
    .description('SwarmClaw CLI')
    .option('-u, --url <url>', 'SwarmClaw base URL', DEFAULT_BASE_URL)
    .option('-k, --key <key>', 'SwarmClaw access key', DEFAULT_ACCESS_KEY)
    .option('--raw', 'Print compact JSON output')
    .showHelpAfterError()

  const agents = program.command('agents').description('Manage agents')

  agents
    .command('list')
    .description('List agents')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/agents'))
    })

  agents
    .command('get')
    .description('Get agent by id')
    .argument('<id>', 'Agent id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => resolveByIdFromCollection(ctx, '/agents', id))
    })

  const tasks = program.command('tasks').description('Manage tasks')

  tasks
    .command('list')
    .description('List tasks')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/tasks'))
    })

  tasks
    .command('get')
    .description('Get task by id')
    .argument('<id>', 'Task id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/tasks/${encodeURIComponent(id)}`))
    })

  tasks
    .command('create')
    .description('Create task')
    .requiredOption('--title <title>', 'Task title')
    .option('--description <description>', 'Task description', '')
    .option('--agent-id <agentId>', 'Agent id')
    .option('--status <status>', 'Task status', 'backlog')
    .action(async function (opts: { title: string; description: string; agentId?: string; status: string }) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/tasks', compactObject({
        title: opts.title,
        description: opts.description,
        agentId: opts.agentId,
        status: opts.status,
      })))
    })

  tasks
    .command('update')
    .description('Update task')
    .argument('<id>', 'Task id')
    .option('--title <title>', 'Task title')
    .option('--description <description>', 'Task description')
    .option('--agent-id <agentId>', 'Agent id')
    .option('--status <status>', 'Task status')
    .option('--session-id <sessionId>', 'Session id')
    .option('--result <result>', 'Task result summary')
    .option('--error <error>', 'Task error summary')
    .action(async function (
      id: string,
      opts: {
        title?: string
        description?: string
        agentId?: string
        status?: string
        sessionId?: string
        result?: string
        error?: string
      },
    ) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/tasks/${encodeURIComponent(id)}`, compactObject({
        title: opts.title,
        description: opts.description,
        agentId: opts.agentId,
        status: opts.status,
        sessionId: opts.sessionId,
        result: opts.result,
        error: opts.error,
      })))
    })

  tasks
    .command('delete')
    .description('Archive task')
    .argument('<id>', 'Task id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'DELETE', `/tasks/${encodeURIComponent(id)}`))
    })

  tasks
    .command('archive')
    .description('Archive task')
    .argument('<id>', 'Task id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'DELETE', `/tasks/${encodeURIComponent(id)}`))
    })

  const schedules = program.command('schedules').description('Manage schedules')

  schedules
    .command('list')
    .description('List schedules')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/schedules'))
    })

  schedules
    .command('get')
    .description('Get schedule by id')
    .argument('<id>', 'Schedule id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => resolveByIdFromCollection(ctx, '/schedules', id))
    })

  schedules
    .command('create')
    .description('Create schedule')
    .requiredOption('--name <name>', 'Schedule name')
    .requiredOption('--agent-id <agentId>', 'Agent id')
    .requiredOption('--task-prompt <taskPrompt>', 'Task prompt for the scheduled run')
    .option('--schedule-type <scheduleType>', 'cron | interval | once', 'cron')
    .option('--cron <cron>', 'Cron expression')
    .option('--interval-ms <intervalMs>', 'Interval in milliseconds')
    .option('--run-at <runAt>', 'Timestamp (ms) or ISO time for once schedules')
    .option('--status <status>', 'Schedule status', 'active')
    .action(async function (opts: {
      name: string
      agentId: string
      taskPrompt: string
      scheduleType: string
      cron?: string
      intervalMs?: string
      runAt?: string
      status: string
    }) {
      const intervalMs = opts.intervalMs ? Number.parseInt(opts.intervalMs, 10) : undefined
      if (opts.intervalMs && (!Number.isFinite(intervalMs) || intervalMs! <= 0)) {
        throw new Error(`Invalid --interval-ms value: ${opts.intervalMs}`)
      }

      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/schedules', compactObject({
        name: opts.name,
        agentId: opts.agentId,
        taskPrompt: opts.taskPrompt,
        scheduleType: opts.scheduleType,
        cron: opts.cron,
        intervalMs,
        runAt: parseTimestamp(opts.runAt),
        status: opts.status,
      })))
    })

  const runs = program.command('runs').description('Inspect queued/running/completed runs')

  runs
    .command('list')
    .description('List runs')
    .option('--session-id <sessionId>', 'Filter by session id')
    .option('--status <status>', 'Filter by run status')
    .option('--limit <limit>', 'Max rows to return (1-1000)')
    .action(async function (opts: { sessionId?: string; status?: string; limit?: string }) {
      const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined
      if (opts.limit && (!Number.isFinite(limit) || limit! <= 0)) {
        throw new Error(`Invalid --limit value: ${opts.limit}`)
      }
      await runWithHandler(this as Command, (ctx) => {
        const params = new URLSearchParams()
        if (opts.sessionId) params.set('sessionId', opts.sessionId)
        if (opts.status) params.set('status', opts.status)
        if (typeof limit === 'number') params.set('limit', String(limit))
        return apiRequest(ctx, 'GET', '/runs', undefined, params)
      })
    })

  runs
    .command('get')
    .description('Get run by id')
    .argument('<id>', 'Run id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/runs/${encodeURIComponent(id)}`))
    })

  const sessions = program.command('sessions').description('Manage sessions')

  sessions
    .command('list')
    .description('List sessions')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/sessions'))
    })

  sessions
    .command('get')
    .description('Get session by id')
    .argument('<id>', 'Session id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => resolveByIdFromCollection(ctx, '/sessions', id))
    })

  sessions
    .command('create')
    .description('Create session')
    .option('--name <name>', 'Session name', 'New Session')
    .option('--user <user>', 'User name')
    .option('--cwd <cwd>', 'Working directory')
    .option('--provider <provider>', 'Provider id')
    .option('--model <model>', 'Model name')
    .option('--agent-id <agentId>', 'Agent id')
    .option('--credential-id <credentialId>', 'Credential id')
    .option('--api-endpoint <apiEndpoint>', 'API endpoint')
    .option('--heartbeat-enabled <heartbeatEnabled>', 'Heartbeat enabled (true|false)')
    .option('--heartbeat-interval-sec <heartbeatIntervalSec>', 'Heartbeat interval seconds')
    .action(async function (opts: {
      name: string
      user?: string
      cwd?: string
      provider?: string
      model?: string
      agentId?: string
      credentialId?: string
      apiEndpoint?: string
      heartbeatEnabled?: string
      heartbeatIntervalSec?: string
    }) {
      const heartbeatEnabled = typeof opts.heartbeatEnabled === 'string'
        ? opts.heartbeatEnabled.trim().toLowerCase() === 'true'
        : undefined
      const heartbeatIntervalSec = opts.heartbeatIntervalSec ? Number.parseInt(opts.heartbeatIntervalSec, 10) : undefined
      if (opts.heartbeatIntervalSec && (!Number.isFinite(heartbeatIntervalSec) || heartbeatIntervalSec! < 0)) {
        throw new Error(`Invalid --heartbeat-interval-sec value: ${opts.heartbeatIntervalSec}`)
      }
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/sessions', compactObject({
        name: opts.name,
        user: opts.user,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
        agentId: opts.agentId,
        credentialId: opts.credentialId,
        apiEndpoint: opts.apiEndpoint,
        heartbeatEnabled: typeof opts.heartbeatEnabled === 'string' ? heartbeatEnabled : undefined,
        heartbeatIntervalSec,
      })))
    })

  sessions
    .command('update')
    .description('Update session')
    .argument('<id>', 'Session id')
    .option('--name <name>', 'Session name')
    .option('--cwd <cwd>', 'Working directory')
    .option('--agent-id <agentId>', 'Agent id')
    .option('--tools <json>', 'Tools JSON array, e.g. ["shell","memory"]')
    .option('--heartbeat-enabled <heartbeatEnabled>', 'Heartbeat enabled (true|false)')
    .option('--heartbeat-interval-sec <heartbeatIntervalSec>', 'Heartbeat interval seconds')
    .action(async function (
      id: string,
      opts: {
        name?: string
        cwd?: string
        agentId?: string
        tools?: string
        heartbeatEnabled?: string
        heartbeatIntervalSec?: string
      },
    ) {
      const heartbeatEnabled = typeof opts.heartbeatEnabled === 'string'
        ? opts.heartbeatEnabled.trim().toLowerCase() === 'true'
        : undefined
      const heartbeatIntervalSec = opts.heartbeatIntervalSec ? Number.parseInt(opts.heartbeatIntervalSec, 10) : undefined
      if (opts.heartbeatIntervalSec && (!Number.isFinite(heartbeatIntervalSec) || heartbeatIntervalSec! < 0)) {
        throw new Error(`Invalid --heartbeat-interval-sec value: ${opts.heartbeatIntervalSec}`)
      }
      const tools = parseJsonValue(opts.tools, '--tools')
      if (tools !== undefined && !Array.isArray(tools)) {
        throw new Error('--tools must be a JSON array')
      }
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/sessions/${encodeURIComponent(id)}`, compactObject({
        name: opts.name,
        cwd: opts.cwd,
        agentId: opts.agentId,
        tools,
        heartbeatEnabled: typeof opts.heartbeatEnabled === 'string' ? heartbeatEnabled : undefined,
        heartbeatIntervalSec,
      })))
    })

  sessions
    .command('delete')
    .description('Delete session')
    .argument('<id>', 'Session id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'DELETE', `/sessions/${encodeURIComponent(id)}`))
    })

  sessions
    .command('history')
    .description('Get session message history')
    .argument('<id>', 'Session id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/sessions/${encodeURIComponent(id)}/messages`))
    })

  sessions
    .command('stop')
    .description('Stop running work for a session')
    .argument('<id>', 'Session id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', `/sessions/${encodeURIComponent(id)}/stop`))
    })

  const memory = program.command('memory').description('Manage memory')

  memory
    .command('get')
    .description('Get memory by id')
    .argument('<id>', 'Memory id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/memory/${encodeURIComponent(id)}`))
    })

  memory
    .command('search')
    .description('Search memory')
    .requiredOption('-q, --q <query>', 'Search query')
    .option('--agent-id <agentId>', 'Filter by agent id')
    .action(async function (opts: { q: string; agentId?: string }) {
      await runWithHandler(this as Command, (ctx) => {
        const params = new URLSearchParams()
        params.set('q', opts.q)
        if (opts.agentId) params.set('agentId', opts.agentId)
        return apiRequest(ctx, 'GET', '/memory', undefined, params)
      })
    })

  memory
    .command('store')
    .description('Store memory')
    .requiredOption('--title <title>', 'Memory title')
    .requiredOption('--content <content>', 'Memory content')
    .option('--category <category>', 'Memory category', 'note')
    .option('--agent-id <agentId>', 'Associated agent id')
    .option('--session-id <sessionId>', 'Associated session id')
    .option('--metadata <json>', 'Metadata JSON object, ex: {"priority":"high"}')
    .action(async function (opts: {
      title: string
      content: string
      category: string
      agentId?: string
      sessionId?: string
      metadata?: string
    }) {
      const metadata = parseMetadata(opts.metadata)
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/memory', compactObject({
        title: opts.title,
        content: opts.content,
        category: opts.category,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        metadata,
      })))
    })

  const memoryImages = program.command('memory-images').description('Fetch memory image assets')

  memoryImages
    .command('get')
    .description('Download memory image by filename')
    .argument('<filename>', 'Memory image filename')
    .action(async function (filename: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/memory-images/${encodeURIComponent(filename)}`))
    })

  const connectors = program.command('connectors').description('Manage connectors')

  connectors
    .command('list')
    .description('List connectors')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/connectors'))
    })

  connectors
    .command('get')
    .description('Get connector by id')
    .argument('<id>', 'Connector id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/connectors/${encodeURIComponent(id)}`))
    })

  connectors
    .command('create')
    .description('Create connector')
    .requiredOption('--platform <platform>', 'Connector platform (discord|telegram|slack|whatsapp|openclaw)')
    .requiredOption('--agent-id <agentId>', 'Agent id')
    .option('--name <name>', 'Connector name')
    .option('--credential-id <credentialId>', 'Credential id')
    .option('--config <json>', 'Connector config JSON object')
    .option('--auto-start <autoStart>', 'Auto-start connector (true|false)')
    .action(async function (opts: {
      platform: string
      agentId: string
      name?: string
      credentialId?: string
      config?: string
      autoStart?: string
    }) {
      const config = parseJsonValue(opts.config, '--config')
      if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
        throw new Error('--config must be a JSON object')
      }
      const autoStart = typeof opts.autoStart === 'string'
        ? opts.autoStart.trim().toLowerCase() === 'true'
        : undefined
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/connectors', compactObject({
        platform: opts.platform,
        agentId: opts.agentId,
        name: opts.name,
        credentialId: opts.credentialId,
        config,
        autoStart: typeof opts.autoStart === 'string' ? autoStart : undefined,
      })))
    })

  connectors
    .command('update')
    .description('Update connector')
    .argument('<id>', 'Connector id')
    .option('--name <name>', 'Connector name')
    .option('--agent-id <agentId>', 'Agent id')
    .option('--credential-id <credentialId>', 'Credential id')
    .option('--config <json>', 'Connector config JSON object')
    .option('--enabled', 'Enable connector')
    .option('--disabled', 'Disable connector')
    .action(async function (
      id: string,
      opts: {
        name?: string
        agentId?: string
        credentialId?: string
        config?: string
        enabled?: boolean
        disabled?: boolean
      },
    ) {
      const config = parseJsonValue(opts.config, '--config')
      if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
        throw new Error('--config must be a JSON object')
      }
      const isEnabled = opts.enabled ? true : opts.disabled ? false : undefined
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, compactObject({
        name: opts.name,
        agentId: opts.agentId,
        credentialId: opts.credentialId,
        config,
        isEnabled,
      })))
    })

  connectors
    .command('delete')
    .description('Delete connector')
    .argument('<id>', 'Connector id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'DELETE', `/connectors/${encodeURIComponent(id)}`))
    })

  connectors
    .command('start')
    .description('Start connector runtime')
    .argument('<id>', 'Connector id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, { action: 'start' }))
    })

  connectors
    .command('stop')
    .description('Stop connector runtime')
    .argument('<id>', 'Connector id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, { action: 'stop' }))
    })

  connectors
    .command('repair')
    .description('Repair connector runtime (platform specific)')
    .argument('<id>', 'Connector id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/connectors/${encodeURIComponent(id)}`, { action: 'repair' }))
    })

  const webhooks = program.command('webhooks').description('Manage webhooks')

  webhooks
    .command('list')
    .description('List webhooks')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/webhooks'))
    })

  webhooks
    .command('get')
    .description('Get webhook by id')
    .argument('<id>', 'Webhook id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/webhooks/${encodeURIComponent(id)}`))
    })

  webhooks
    .command('create')
    .description('Create webhook')
    .option('--name <name>', 'Webhook name', 'Unnamed Webhook')
    .option('--source <source>', 'Webhook source', 'custom')
    .option('--event <event>', 'Webhook event filter (repeatable)', collectValues, [])
    .option('--agent-id <agentId>', 'Agent id')
    .option('--secret <secret>', 'Webhook secret')
    .option('--disabled', 'Create webhook in disabled state')
    .action(async function (opts: {
      name: string
      source: string
      event: string[]
      agentId?: string
      secret?: string
      disabled?: boolean
    }) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/webhooks', compactObject({
        name: opts.name,
        source: opts.source,
        events: opts.event,
        agentId: opts.agentId,
        secret: opts.secret,
        isEnabled: opts.disabled ? false : true,
      })))
    })

  webhooks
    .command('update')
    .description('Update webhook')
    .argument('<id>', 'Webhook id')
    .option('--name <name>', 'Webhook name')
    .option('--source <source>', 'Webhook source')
    .option('--event <event>', 'Webhook event filter (repeatable)', collectValues, [])
    .option('--agent-id <agentId>', 'Agent id')
    .option('--secret <secret>', 'Webhook secret')
    .option('--enabled', 'Enable webhook')
    .option('--disabled', 'Disable webhook')
    .action(async function (
      id: string,
      opts: {
        name?: string
        source?: string
        event: string[]
        agentId?: string
        secret?: string
        enabled?: boolean
        disabled?: boolean
      },
    ) {
      const isEnabled = opts.enabled ? true : opts.disabled ? false : undefined
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'PUT', `/webhooks/${encodeURIComponent(id)}`, compactObject({
        name: opts.name,
        source: opts.source,
        events: opts.event.length ? opts.event : undefined,
        agentId: opts.agentId,
        secret: opts.secret,
        isEnabled,
      })))
    })

  webhooks
    .command('delete')
    .description('Delete webhook')
    .argument('<id>', 'Webhook id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'DELETE', `/webhooks/${encodeURIComponent(id)}`))
    })

  webhooks
    .command('trigger')
    .description('Trigger webhook by id')
    .argument('<id>', 'Webhook id')
    .option('--event <event>', 'Event type')
    .option('--secret <secret>', 'Webhook secret')
    .option('--payload <json>', 'JSON payload body')
    .action(async function (
      id: string,
      opts: { event?: string; secret?: string; payload?: string },
    ) {
      const payload = parseJsonValue(opts.payload, '--payload') ?? {}
      await runWithHandler(this as Command, (ctx) => {
        const params = new URLSearchParams()
        if (opts.event) params.set('event', opts.event)
        if (opts.secret) params.set('secret', opts.secret)
        return apiRequest(ctx, 'POST', `/webhooks/${encodeURIComponent(id)}`, payload, params)
      })
    })

  return program
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const program = buildProgram()
  try {
    await program.parseAsync(['node', 'swarmclaw', ...argv])
    return (process.exitCode as number | undefined) ?? 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(msg)
    return 1
  }
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2))
  if (code !== 0) process.exitCode = code
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  void main()
}
