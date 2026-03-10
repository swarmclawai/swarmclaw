import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { ToolBuildContext } from './context'
import { findBinaryOnPath, MAX_OUTPUT, tail, truncate } from './context'
import { errorMessage } from '@/lib/shared-utils'

interface GoogleWorkspaceConfig {
  accessToken: string
  credentialsFile: string
  credentialsJson: string
  clientId: string
  clientSecret: string
  configDir: string
  projectId: string
  sanitizeTemplate: string
  sanitizeMode: 'warn' | 'block'
}

interface GoogleWorkspaceActionArgs {
  args: string[]
  params?: Record<string, unknown> | unknown[] | string
  jsonInput?: Record<string, unknown> | unknown[] | string
  uploadPath?: string
  dryRun?: boolean
  pageAll?: boolean
  sanitize?: string
  stdin?: string
  timeoutSec?: number
}

interface GoogleWorkspaceRuntimeDeps {
  cwd?: string
  defaultTimeoutMs?: number
  findBinaryOnPath: (binaryName: string) => string | null
  spawn: typeof spawn
  getConfig: () => GoogleWorkspaceConfig
}

const INTERACTIVE_AUTH_COMMANDS = new Set(['login', 'setup'])

function getGoogleWorkspaceConfig(): GoogleWorkspaceConfig {
  const ps = getPluginManager().getPluginSettings('google_workspace')
  const sanitizeMode = String(ps.sanitizeMode || 'warn').trim().toLowerCase()
  return {
    accessToken: String(ps.accessToken || '').trim(),
    credentialsFile: String(ps.credentialsFile || '').trim(),
    credentialsJson: String(ps.credentialsJson || '').trim(),
    clientId: String(ps.clientId || '').trim(),
    clientSecret: String(ps.clientSecret || '').trim(),
    configDir: String(ps.configDir || '').trim(),
    projectId: String(ps.projectId || '').trim(),
    sanitizeTemplate: String(ps.sanitizeTemplate || '').trim(),
    sanitizeMode: sanitizeMode === 'block' ? 'block' : 'warn',
  }
}

function normalizeGoogleWorkspaceArgs(rawArgs: Record<string, unknown>): GoogleWorkspaceActionArgs {
  const normalized = normalizeToolInputArgs(rawArgs)
  const directArgs = Array.isArray(normalized.args)
    ? normalized.args
    : typeof normalized.command === 'string'
      ? normalized.command.split(/\s+/)
      : []

  return {
    args: directArgs
      .map((value) => typeof value === 'string' ? value.trim() : String(value ?? '').trim())
      .filter(Boolean),
    params: (
      typeof normalized.params === 'string'
      || Array.isArray(normalized.params)
      || (normalized.params && typeof normalized.params === 'object')
    ) ? normalized.params as Record<string, unknown> | unknown[] | string : undefined,
    jsonInput: (
      typeof normalized.jsonInput === 'string'
      || Array.isArray(normalized.jsonInput)
      || (normalized.jsonInput && typeof normalized.jsonInput === 'object')
    ) ? normalized.jsonInput as Record<string, unknown> | unknown[] | string : undefined,
    uploadPath: typeof normalized.uploadPath === 'string' ? normalized.uploadPath.trim() : undefined,
    dryRun: normalized.dryRun === true,
    pageAll: normalized.pageAll === true,
    sanitize: typeof normalized.sanitize === 'string' ? normalized.sanitize.trim() : undefined,
    stdin: typeof normalized.stdin === 'string' ? normalized.stdin : undefined,
    timeoutSec: typeof normalized.timeoutSec === 'number' && Number.isFinite(normalized.timeoutSec)
      ? normalized.timeoutSec
      : undefined,
  }
}

function stringifyFlagValue(value: Record<string, unknown> | unknown[] | string): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function buildGoogleWorkspaceEnv(config: GoogleWorkspaceConfig): { env: NodeJS.ProcessEnv; tempDir: string | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
  let tempDir: string | null = null

  if (config.accessToken) env.GOOGLE_WORKSPACE_CLI_TOKEN = config.accessToken
  if (config.clientId) env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = config.clientId
  if (config.clientSecret) env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = config.clientSecret
  if (config.configDir) env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = config.configDir
  if (config.projectId) env.GOOGLE_WORKSPACE_PROJECT_ID = config.projectId
  if (config.sanitizeTemplate) env.GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE = config.sanitizeTemplate
  if (config.sanitizeMode) env.GOOGLE_WORKSPACE_CLI_SANITIZE_MODE = config.sanitizeMode

  if (config.credentialsJson) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-gws-'))
    const credentialsPath = path.join(tempDir, 'credentials.json')
    fs.writeFileSync(credentialsPath, config.credentialsJson, 'utf8')
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentialsPath
  } else if (config.credentialsFile) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = config.credentialsFile
  }

  return { env, tempDir }
}

function isInteractiveAuthCommand(args: string[]): boolean {
  if (args.length < 2) return false
  return args[0] === 'auth' && INTERACTIVE_AUTH_COMMANDS.has(args[1])
}

function formatGoogleWorkspaceStdout(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return ''

  try {
    return truncate(JSON.stringify(JSON.parse(trimmed), null, 2), MAX_OUTPUT)
  } catch {
    // Continue below.
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length > 1) {
    const parsedLines: unknown[] = []
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line))
      } catch {
        parsedLines.length = 0
        break
      }
    }
    if (parsedLines.length === lines.length) {
      return truncate(JSON.stringify(parsedLines, null, 2), MAX_OUTPUT)
    }
  }

  return truncate(trimmed, MAX_OUTPUT)
}

export async function executeGoogleWorkspaceAction(
  rawArgs: Record<string, unknown>,
  deps: GoogleWorkspaceRuntimeDeps = {
    cwd: process.cwd(),
    findBinaryOnPath,
    spawn,
    getConfig: getGoogleWorkspaceConfig,
  },
): Promise<string> {
  const args = normalizeGoogleWorkspaceArgs(rawArgs)
  if (args.args.length === 0) {
    return 'Error: `args` is required. Example: `{"args":["drive","files","list"],"params":{"pageSize":5}}`.'
  }

  if (isInteractiveAuthCommand(args.args)) {
    return 'Error: interactive `gws auth login` / `gws auth setup` is not supported inside agent tool runs. Configure Google Workspace CLI auth in the plugin settings or run the auth flow manually in a terminal first.'
  }

  const binary = deps.findBinaryOnPath('gws')
  if (!binary) {
    return 'Error: `gws` is not installed. Install Google Workspace CLI with `npm install -g @googleworkspace/cli` or a release binary from github.com/googleworkspace/cli/releases.'
  }

  const config = deps.getConfig()
  const { env, tempDir } = buildGoogleWorkspaceEnv(config)
  const commandArgs = [...args.args]
  if (args.params !== undefined) commandArgs.push('--params', stringifyFlagValue(args.params))
  if (args.jsonInput !== undefined) commandArgs.push('--json', stringifyFlagValue(args.jsonInput))
  if (args.uploadPath) commandArgs.push('--upload', args.uploadPath)
  if (args.dryRun) commandArgs.push('--dry-run')
  if (args.pageAll) commandArgs.push('--page-all')
  if (args.sanitize) commandArgs.push('--sanitize', args.sanitize)

  const timeoutMs = Math.max(
    1_000,
    Math.min(
      args.timeoutSec != null ? Math.round(args.timeoutSec * 1000) : (deps.defaultTimeoutMs || 60_000),
      5 * 60_000,
    ),
  )

  return await new Promise<string>((resolve) => {
    let child: ChildProcess | null = null
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (message: string) => {
      if (settled) return
      settled = true
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
      resolve(message)
    }

    try {
      child = deps.spawn(binary, commandArgs, {
        cwd: deps.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      finish(`Error: ${errorMessage(err)}`)
      return
    }

    const timer = setTimeout(() => {
      try { child?.kill('SIGTERM') } catch { /* ignore */ }
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(-MAX_OUTPUT * 2)
    })

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      finish(`Error: ${err.message}`)
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const output = formatGoogleWorkspaceStdout(stdout)
      const errText = tail(stderr.trim(), 4000)
      if (code === 0) {
        if (output) {
          finish(output)
          return
        }
        if (errText) {
          finish(`Error: ${errText}`)
          return
        }
        finish('OK')
        return
      }

      const details = errText || output || `gws exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`
      finish(`Error: ${details}`)
    })

    if (args.stdin) {
      child.stdin?.write(args.stdin)
    }
    child.stdin?.end()
  })
}

const GoogleWorkspacePlugin: Plugin = {
  name: 'Google Workspace CLI',
  description: 'Run Google Workspace CLI (`gws`) commands for Drive, Docs, Sheets, Gmail, Calendar, Chat, and other Workspace APIs.',
  hooks: {
    getCapabilityDescription: () => 'I can use Google Workspace CLI (`google_workspace`) to inspect and automate Drive, Gmail, Calendar, Docs, Sheets, and other Google Workspace APIs with structured JSON output.',
    getOperatingGuidance: () => [
      'Use `google_workspace` for Google Workspace tasks instead of generic `http_request` whenever `gws` can handle the API directly.',
      'Prefer read/list/get commands first to verify identifiers and current state before issuing mutating Workspace operations.',
      'Do not attempt interactive `gws auth login` or `gws auth setup` inside a tool run; rely on plugin settings or preconfigured CLI auth.',
    ],
  } as PluginHooks,
  ui: {
    settingsFields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'secret',
        help: 'Maps to GOOGLE_WORKSPACE_CLI_TOKEN. Preferred when you already have an OAuth access token.',
      },
      {
        key: 'credentialsFile',
        label: 'Credentials File',
        type: 'text',
        placeholder: '/absolute/path/to/credentials.json',
        help: 'Maps to GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE. Use a user or service-account credentials JSON file.',
      },
      {
        key: 'credentialsJson',
        label: 'Credentials JSON',
        type: 'secret',
        help: 'Optional inline credentials JSON. SwarmClaw writes this to a temp file and points gws at it during execution.',
      },
      {
        key: 'clientId',
        label: 'OAuth Client ID',
        type: 'text',
        placeholder: '1234567890-abc.apps.googleusercontent.com',
        help: 'Maps to GOOGLE_WORKSPACE_CLI_CLIENT_ID.',
      },
      {
        key: 'clientSecret',
        label: 'OAuth Client Secret',
        type: 'secret',
        help: 'Maps to GOOGLE_WORKSPACE_CLI_CLIENT_SECRET.',
      },
      {
        key: 'configDir',
        label: 'Config Directory',
        type: 'text',
        placeholder: '~/.config/gws',
        help: 'Optional override for GOOGLE_WORKSPACE_CLI_CONFIG_DIR.',
      },
      {
        key: 'projectId',
        label: 'Project ID',
        type: 'text',
        placeholder: 'my-gcp-project',
        help: 'Optional GOOGLE_WORKSPACE_PROJECT_ID fallback for Gmail watch and events subscribe commands.',
      },
      {
        key: 'sanitizeTemplate',
        label: 'Sanitize Template',
        type: 'text',
        placeholder: 'projects/.../locations/.../templates/...',
        help: 'Optional GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE default.',
      },
      {
        key: 'sanitizeMode',
        label: 'Sanitize Mode',
        type: 'select',
        defaultValue: 'warn',
        options: [
          { value: 'warn', label: 'Warn' },
          { value: 'block', label: 'Block' },
        ],
        help: 'Optional GOOGLE_WORKSPACE_CLI_SANITIZE_MODE default.',
      },
    ],
  },
  tools: [
    {
      name: 'google_workspace',
      description: 'Run a Google Workspace CLI (`gws`) command with structured JSON output.',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command arguments after `gws`, for example ["drive","files","list"] or ["docs","get","--document-id","..."].',
          },
          params: {
            anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
            description: 'Value for the `--params` flag. Objects/arrays are JSON-stringified automatically.',
          },
          jsonInput: {
            anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
            description: 'Value for the `--json` flag. Objects/arrays are JSON-stringified automatically.',
          },
          uploadPath: { type: 'string', description: 'Optional path passed to `--upload`.' },
          dryRun: { type: 'boolean', description: 'Add `--dry-run` to preview the request without executing it.' },
          pageAll: { type: 'boolean', description: 'Add `--page-all` to auto-paginate list operations.' },
          sanitize: { type: 'string', description: 'Optional `--sanitize` template override for this command.' },
          stdin: { type: 'string', description: 'Optional stdin payload for commands that read from standard input.' },
          timeoutSec: { type: 'number', description: 'Timeout in seconds. Defaults to the CLI process timeout.' },
        },
        required: ['args'],
      },
      execute: async (args) => executeGoogleWorkspaceAction(args),
    },
  ],
}

getPluginManager().registerBuiltin('google_workspace', GoogleWorkspacePlugin)

export function buildGoogleWorkspaceTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('google_workspace')) return []

  return [
    tool(
      (args: GoogleWorkspaceActionArgs) => executeGoogleWorkspaceAction(args as unknown as Record<string, unknown>, {
        cwd: bctx.cwd,
        defaultTimeoutMs: bctx.cliProcessTimeoutMs,
        findBinaryOnPath,
        spawn,
        getConfig: getGoogleWorkspaceConfig,
      }),
      {
        name: 'google_workspace',
        description: GoogleWorkspacePlugin.tools![0].description,
        schema: z.object({
          args: z.array(z.string()).min(1).describe('Arguments to pass after `gws`. Example: ["drive","files","list"].'),
          params: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional().describe('Optional value for `--params`.'),
          jsonInput: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional().describe('Optional value for `--json`.'),
          uploadPath: z.string().optional().describe('Optional file path for `--upload`.'),
          dryRun: z.boolean().optional().describe('Add `--dry-run` to preview the request only.'),
          pageAll: z.boolean().optional().describe('Add `--page-all` for auto-pagination.'),
          sanitize: z.string().optional().describe('Optional sanitize template override for this command.'),
          stdin: z.string().optional().describe('Optional stdin content.'),
          timeoutSec: z.number().optional().describe('Timeout in seconds.'),
        }),
      },
    ),
  ]
}
