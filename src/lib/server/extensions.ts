import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import type {
  Extension,
  ExtensionHooks,
  ExtensionMeta,
  ExtensionToolDef,
  ExtensionUIDefinition,
  ExtensionProviderDefinition,
  ExtensionConnectorDefinition,
  Session,
  ExtensionPackageManager,
  ExtensionDependencyInstallStatus,
  ExtensionPromptBuildResult,
  ExtensionToolCallResult,
  ExtensionModelResolveResult,
  ExtensionBeforeMessageWriteResult,
  ExtensionSubagentSpawningResult,
  Message,
} from '@/types'
import {
  inferExtensionInstallSourceFromUrl,
  inferExtensionPublisherSourceFromUrl,
  isMarketplaceInstallSource,
  normalizeExtensionInstallSource,
  normalizeExtensionPublisherSource,
} from '@/lib/extension-sources'
import { DATA_DIR } from './data-dir'
import { canonicalizeExtensionId, expandExtensionIds, getExtensionAliases } from './tool-aliases'
import { log } from './logger'
import { createNotification } from './create-notification'
import { notify } from './ws-hub'
import { decryptKey, encryptKey, loadSettings, saveSettings } from './storage'
import { buildExtensionHooks } from './extensions-approval-guidance'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'

const EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions')
const EXTENSION_WORKSPACES_DIR = path.join(EXTENSIONS_DIR, '.workspaces')
const EXTENSIONS_CONFIG = path.join(DATA_DIR, 'extensions.json')
const EXTENSION_FAILURES = path.join(DATA_DIR, 'extension-failures.json')

// Backward-compat: migrate legacy paths on first access
const _migrateLegacyPaths = (() => {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      const legacyDir = path.join(DATA_DIR, 'plugins')
      if (fs.existsSync(legacyDir) && !fs.existsSync(EXTENSIONS_DIR)) {
        fs.renameSync(legacyDir, EXTENSIONS_DIR)
      }
      const legacyConfig = path.join(DATA_DIR, 'plugins.json')
      if (fs.existsSync(legacyConfig) && !fs.existsSync(EXTENSIONS_CONFIG)) {
        fs.renameSync(legacyConfig, EXTENSIONS_CONFIG)
      }
      const legacyFailures = path.join(DATA_DIR, 'plugin-failures.json')
      if (fs.existsSync(legacyFailures) && !fs.existsSync(EXTENSION_FAILURES)) {
        fs.renameSync(legacyFailures, EXTENSION_FAILURES)
      }
    } catch { /* ignore migration errors */ }
  }
})()
const MAX_EXTERNAL_EXTENSION_BYTES = 1024 * 1024
const SUPPORTED_EXTENSION_PACKAGE_MANAGERS: ExtensionPackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']
const EXTENSION_INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CONSECUTIVE_EXTENSION_FAILURES = (() => {
  const raw = Number.parseInt(process.env.SWARMCLAW_EXTENSION_FAILURE_THRESHOLD || '3', 10)
  if (!Number.isFinite(raw)) return 3
  return Math.max(2, Math.min(20, raw))
})()

interface ExtensionFailureRecord {
  count: number
  lastError: string
  lastStage: string
  lastFailedAt: number
}

interface ExtensionConfigEntry {
  enabled?: boolean
  createdByAgentId?: string
  source?: ExtensionMeta['source']
  sourceLabel?: ExtensionMeta['sourceLabel']
  installSource?: ExtensionMeta['installSource']
  sourceUrl?: string
  sourceHash?: string
  installedAt?: number
  updatedAt?: number
  packageManager?: ExtensionPackageManager
  dependencyInstallStatus?: ExtensionDependencyInstallStatus
  dependencyInstallError?: string
  dependencyInstalledAt?: number
}

interface InstalledExtensionSource {
  filename: string
  sourceUrl: string
  sourceHash: string
  contentType?: string
}

interface ExtensionSourceDownload {
  code: string
  contentType: string
  normalizedUrl: string
  hash: string
}

interface ExtensionDependencyInfo {
  hasManifest: boolean
  dependencyCount: number
  devDependencyCount: number
  packageManager?: ExtensionPackageManager
  installStatus: ExtensionDependencyInstallStatus
  installError?: string
  installedAt?: number
}

interface UpsertExtensionOptions {
  packageJson?: unknown
  packageManager?: string | null
  installDependencies?: boolean
  meta?: Record<string, unknown>
}

interface ExtensionSecretSettingValue {
  __extensionSecret: true
  encrypted: string
}

interface ExtensionLogger {
  info: (msg: string, m?: unknown) => void
  warn: (msg: string, m?: unknown) => void
  error: (msg: string, m?: unknown) => void
}

type HookRegistrar = {
  onAgentStart?: (fn: (...args: unknown[]) => unknown) => void
  onAgentComplete?: (fn: (...args: unknown[]) => unknown) => void
  onBeforeModelResolve?: (fn: (...args: unknown[]) => unknown) => void
  onBeforePromptBuild?: (fn: (...args: unknown[]) => unknown) => void
  onBeforeToolCall?: (fn: (...args: unknown[]) => unknown) => void
  onToolCall?: (fn: (...args: unknown[]) => unknown) => void
  onToolResult?: (fn: (...args: unknown[]) => unknown) => void
  onMessage?: (fn: (...args: unknown[]) => unknown) => void
}

type HookContext<K extends keyof ExtensionHooks> =
  ExtensionHooks[K] extends ((ctx: infer C) => unknown) | undefined ? C : never

/** Legacy OpenClaw format: activate(ctx)/deactivate() */
interface OpenClawLegacyExtension {
  name: string
  version?: string
  activate: (ctx: HookRegistrar & { registerTool: (def: ExtensionToolDef) => void; log: ExtensionLogger }) => void
  deactivate?: () => void
}

/**
 * Real OpenClaw extension format: function export `(api) => {}` or object with `register(api)`.
 * Supports api.registerHook(), api.registerTool(), api.registerCommand(), api.registerService().
 */
interface OpenClawExtensionApi {
  registerHook: (event: string, handler: (...args: unknown[]) => unknown, meta?: { name?: string; description?: string }) => void
  registerTool: (def: ExtensionToolDef | { name: string; description?: string; parameters?: Record<string, unknown>; planning?: ExtensionToolDef['planning']; execute: (...args: unknown[]) => unknown }) => void
  registerCommand: (def: { name: string; description?: string; handler: (...args: unknown[]) => unknown }) => void
  registerService: (def: { id: string; start: () => void; stop?: () => void }) => void
  registerProvider: (def: Record<string, unknown>) => void
  registerChannel: (def: Record<string, unknown>) => void
  registerGatewayMethod: (name: string, handler: (...args: unknown[]) => unknown) => void
  registerCli: (fn: (...args: unknown[]) => unknown, meta?: { commands?: string[] }) => void
  logger: ExtensionLogger
  log: ExtensionLogger
  config: Record<string, unknown>
  runtime: Record<string, unknown>
}

export interface HookExecutionOptions {
  enabledIds?: string[]
  includeAllWhenEmpty?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isExtensionSecretSettingValue(value: unknown): value is ExtensionSecretSettingValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  return rec.__extensionSecret === true && typeof rec.encrypted === 'string'
}

function concatOptionalTextSegments(...segments: Array<string | null | undefined>): string | undefined {
  const normalized = segments
    .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

function mergePromptBuildResults(
  current: ExtensionPromptBuildResult | undefined,
  next: ExtensionPromptBuildResult,
): ExtensionPromptBuildResult {
  return {
    systemPrompt: current?.systemPrompt ?? next.systemPrompt,
    prependContext: concatOptionalTextSegments(current?.prependContext, next.prependContext),
    prependSystemContext: concatOptionalTextSegments(current?.prependSystemContext, next.prependSystemContext),
    appendSystemContext: concatOptionalTextSegments(current?.appendSystemContext, next.appendSystemContext),
  }
}

function mergeModelResolveResults(
  current: ExtensionModelResolveResult | undefined,
  next: ExtensionModelResolveResult,
): ExtensionModelResolveResult {
  return {
    providerOverride: next.providerOverride ?? current?.providerOverride,
    modelOverride: next.modelOverride ?? current?.modelOverride,
    apiEndpointOverride: next.apiEndpointOverride ?? current?.apiEndpointOverride,
  }
}

function isToolCallControlResult(value: unknown): value is ExtensionToolCallResult {
  if (!isRecord(value)) return false
  return 'input' in value || 'params' in value || 'block' in value || 'blockReason' in value || 'warning' in value
}

function isMessageLike(value: unknown): value is Message {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.text === 'string'
    && typeof value.time === 'number'
}

function isBeforeMessageWriteResult(value: unknown): value is ExtensionBeforeMessageWriteResult {
  if (!isRecord(value)) return false
  return 'message' in value || 'block' in value
}

function isSubagentSpawningResult(value: unknown): value is ExtensionSubagentSpawningResult {
  return isRecord(value) && (value.status === 'ok' || value.status === 'error')
}

function mergeToolCallInput(
  currentInput: Record<string, unknown> | null,
  nextInput: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (nextInput === undefined) return currentInput
  if (nextInput === null) return null
  if (currentInput && typeof currentInput === 'object') {
    return { ...currentInput, ...nextInput }
  }
  return nextInput
}

function hashExtensionSource(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function normalizeExtensionPackageManager(raw: unknown): ExtensionPackageManager | null {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!text) return null
  const normalized = text.split('@')[0] as ExtensionPackageManager
  return SUPPORTED_EXTENSION_PACKAGE_MANAGERS.includes(normalized) ? normalized : null
}

function extensionWorkspaceKey(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function trimProcessOutput(output: string): string {
  return output.trim().slice(-4000)
}

function normalizeExtensionManifest(
  rawManifest: unknown,
  filename: string,
  packageManager?: ExtensionPackageManager | null,
): Record<string, unknown> {
  const parsed = typeof rawManifest === 'string'
    ? JSON.parse(rawManifest) as unknown
    : rawManifest
  if (!isRecord(parsed)) throw new Error('Extension package.json must be a JSON object')

  const manifest = { ...parsed } as Record<string, unknown>
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    manifest.name = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9._-]/g, '-')
  }
  if (manifest.private === undefined) manifest.private = true
  if (packageManager && typeof manifest.packageManager !== 'string') {
    manifest.packageManager = packageManager
  }
  return manifest
}

function countManifestDependencies(manifest: Record<string, unknown> | null): {
  dependencyCount: number
  devDependencyCount: number
} {
  const dependencies = isRecord(manifest?.dependencies) ? Object.keys(manifest.dependencies).length : 0
  const devDependencies = isRecord(manifest?.devDependencies) ? Object.keys(manifest.devDependencies).length : 0
  return {
    dependencyCount: dependencies,
    devDependencyCount: devDependencies,
  }
}

function getInstallCommand(packageManager: ExtensionPackageManager): { command: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['install', '--ignore-scripts', '--config.ignore-workspace=true'] }
    case 'yarn':
      return { command: 'yarn', args: ['install', '--ignore-scripts'] }
    case 'bun':
      return { command: 'bun', args: ['install', '--ignore-scripts'] }
    case 'npm':
    default:
      return { command: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'] }
  }
}

function toRawExtensionUrl(url: string): string {
  if (url.includes('github.com') && url.includes('/blob/')) {
    return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
  }
  if (url.includes('gist.github.com')) {
    return url.endsWith('/raw') ? url : `${url}/raw`
  }
  return url
}

function inferStoredExtensionSource(config: ExtensionConfigEntry | null | undefined): ExtensionMeta['source'] {
  if (config?.source === 'local' || config?.source === 'manual' || config?.source === 'marketplace') {
    return config.source
  }
  if (config?.sourceUrl) {
    const installSource = normalizeExtensionInstallSource(config?.installSource)
      || inferExtensionInstallSourceFromUrl(config.sourceUrl)
    return isMarketplaceInstallSource(installSource) ? 'marketplace' : 'manual'
  }
  return 'local'
}

function inferStoredPublisherSource(config: ExtensionConfigEntry | null | undefined): NonNullable<ExtensionMeta['sourceLabel']> {
  return normalizeExtensionPublisherSource(config?.sourceLabel)
    || inferExtensionPublisherSourceFromUrl(config?.sourceUrl)
    || (config?.sourceUrl ? 'manual' : 'local')
}

function inferStoredInstallSource(config: ExtensionConfigEntry | null | undefined): NonNullable<ExtensionMeta['installSource']> {
  return normalizeExtensionInstallSource(config?.installSource)
    || inferExtensionInstallSourceFromUrl(config?.sourceUrl)
    || (config?.sourceUrl ? 'manual' : 'local')
}

export function normalizeMarketplaceExtensionUrl(url: string): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) return trimmed

  const normalized = toRawExtensionUrl(trimmed)

  return normalized
    .replace('/swarmclawai/swarmforge/master/', '/swarmclawai/swarmforge/main/')
}

export function sanitizeExtensionFilename(filename: string): string {
  const trimmed = typeof filename === 'string' ? filename.trim() : ''
  if (!trimmed) throw new Error('Filename is required')
  if (!trimmed.endsWith('.js') && !trimmed.endsWith('.mjs')) {
    throw new Error('Filename must end in .js or .mjs')
  }
  const sanitized = path.basename(trimmed)
  if (sanitized !== trimmed || trimmed.includes('..')) {
    throw new Error('Invalid filename')
  }
  return sanitized
}

async function downloadExtensionSource(url: string): Promise<ExtensionSourceDownload> {
  const normalizedUrl = normalizeMarketplaceExtensionUrl(url)
  if (!normalizedUrl || !normalizedUrl.startsWith('https://')) {
    throw new Error('URL must be a valid HTTPS URL')
  }

  const res = await fetch(normalizedUrl, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) from ${normalizedUrl}`)
  }

  const contentType = res.headers.get('content-type') || ''
  const lengthHeader = res.headers.get('content-length')
  const declaredSize = lengthHeader ? Number.parseInt(lengthHeader, 10) : Number.NaN
  if (Number.isFinite(declaredSize) && declaredSize > MAX_EXTERNAL_EXTENSION_BYTES) {
    throw new Error(`Extension file is too large (${declaredSize} bytes)`)
  }

  let code = await res.text()
  if (Buffer.byteLength(code, 'utf8') > MAX_EXTERNAL_EXTENSION_BYTES) {
    throw new Error(`Extension file exceeds ${MAX_EXTERNAL_EXTENSION_BYTES} bytes`)
  }

  if (contentType.includes('text/html') && code.includes('<!DOCTYPE')) {
    throw new Error('URL returned an HTML page instead of JavaScript. Use a raw/direct link to the extension file.')
  }

  // Compatibility: modern Node exposes global fetch.
  code = code.replace(/const\s+fetch\s*=\s*require\(['"]node-fetch['"]\);?/g, '// node-fetch stripped for compatibility')
  code = code.replace(/import\s+fetch\s+from\s+['"]node-fetch['"];?/g, '// node-fetch stripped for compatibility')

  return {
    code,
    contentType,
    normalizedUrl,
    hash: hashExtensionSource(code),
  }
}

function coerceTools(rawTools: unknown): ExtensionToolDef[] {
  if (Array.isArray(rawTools)) {
    const tools: ExtensionToolDef[] = []
    for (const rawTool of rawTools) {
      if (!isRecord(rawTool)) continue
      const name = typeof rawTool.name === 'string' ? rawTool.name.trim() : ''
      const execute = rawTool.execute
      if (!name || typeof execute !== 'function') continue
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : `Extension tool: ${name}`,
        parameters: isRecord(rawTool.parameters) ? rawTool.parameters : { type: 'object', properties: {} },
        planning: isRecord(rawTool.planning) ? rawTool.planning as ExtensionToolDef['planning'] : undefined,
        execute: execute as ExtensionToolDef['execute'],
      })
    }
    return tools
  }

  // Compatibility: object-map format (e.g. { ping: () => 'pong' }).
  if (isRecord(rawTools)) {
    const tools: ExtensionToolDef[] = []
    for (const [name, rawTool] of Object.entries(rawTools)) {
      if (!name.trim()) continue
      if (typeof rawTool === 'function') {
        tools.push({
          name,
          description: `Extension tool: ${name}`,
          parameters: { type: 'object', properties: {} },
          execute: async (args) => rawTool(args),
        })
        continue
      }
      if (!isRecord(rawTool) || typeof rawTool.execute !== 'function') continue
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : `Extension tool: ${name}`,
        parameters: isRecord(rawTool.parameters) ? rawTool.parameters : { type: 'object', properties: {} },
        planning: isRecord(rawTool.planning) ? rawTool.planning as ExtensionToolDef['planning'] : undefined,
        execute: rawTool.execute as ExtensionToolDef['execute'],
      })
    }
    return tools
  }

  return []
}

function normalizeExtension(mod: unknown): Extension | null {
  const modObj = mod as Record<string, unknown>
  const raw: Record<string, unknown> = (modObj?.default as Record<string, unknown>) || modObj

  if (raw.name && (raw.hooks || raw.tools || raw.ui || raw.providers || raw.connectors)) {
    const hooks = isRecord(raw.hooks) ? (raw.hooks as ExtensionHooks) : {}
    return {
      name: raw.name as string,
      version: (raw.version as string) || '0.0.1',
      description: (raw.description as string) || '',
      author: typeof raw.author === 'string' ? raw.author : undefined,
      openclaw: raw.openclaw === true,
      hooks,
      tools: coerceTools(raw.tools),
      ui: isRecord(raw.ui) ? (raw.ui as ExtensionUIDefinition) : undefined,
      providers: Array.isArray(raw.providers) ? (raw.providers as ExtensionProviderDefinition[]) : undefined,
      connectors: Array.isArray(raw.connectors) ? (raw.connectors as ExtensionConnectorDefinition[]) : undefined,
    } as Extension
  }

  // --- Real OpenClaw format: function export `(api) => {}` or object with `register(api)` ---
  const registerFn = typeof raw === 'function'
    ? raw as (api: OpenClawExtensionApi) => void
    : typeof raw.register === 'function'
      ? raw.register as (api: OpenClawExtensionApi) => void
      : typeof raw.default === 'function' && !raw.name && !raw.hooks
        ? raw.default as (api: OpenClawExtensionApi) => void
        : null

  if (registerFn) {
    const extensionName = (raw.id || raw.name || 'openclaw-extension') as string
    const extensionVersion = (raw.version || '1.0.0') as string
    const extensionDesc = (raw.description || '') as string
    const hooks: ExtensionHooks = {}
    const tools: ExtensionToolDef[] = []

    const hookEventMap: Record<string, keyof ExtensionHooks> = {
      'before_model_resolve': 'beforeModelResolve',
      'before_prompt_build': 'beforePromptBuild',
      'before_tool_call': 'beforeToolCall',
      'llm_input': 'llmInput',
      'llm_output': 'llmOutput',
      'tool_result_persist': 'toolResultPersist',
      'before_message_write': 'beforeMessageWrite',
      'session_start': 'sessionStart',
      'session_end': 'sessionEnd',
      'subagent_spawning': 'subagentSpawning',
      'subagent_spawned': 'subagentSpawned',
      'subagent_ended': 'subagentEnded',
      'agent:start': 'beforeAgentStart',
      'agent:complete': 'afterAgentComplete',
      'tool:call': 'beforeToolExec',
      'tool:result': 'afterToolExec',
      'message': 'onMessage',
      'message:inbound': 'transformInboundMessage',
      'message:outbound': 'transformOutboundMessage',
      'command:new': 'beforeAgentStart',
      'agent:context': 'getAgentContext',
    }

    const extensionLogger: ExtensionLogger = {
      info: (msg: string, m?: unknown) => log.info(`extension:${extensionName}`, msg, m),
      warn: (msg: string, m?: unknown) => log.warn(`extension:${extensionName}`, msg, m),
      error: (msg: string, m?: unknown) => log.error(`extension:${extensionName}`, msg, m),
    }

    const api: OpenClawExtensionApi = {
      registerHook: (event: string, handler: (...args: unknown[]) => unknown) => {
        const hookKey = hookEventMap[event]
        if (hookKey) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(hooks as Record<string, unknown>)[hookKey] = handler as any
        }
      },
      registerTool: (def) => {
        if (def?.name && typeof def.execute === 'function') {
          tools.push({
            name: def.name,
            description: def.description || `Extension tool: ${def.name}`,
            parameters: (def.parameters || { type: 'object', properties: {} }) as Record<string, unknown>,
            planning: isRecord((def as Record<string, unknown>).planning)
              ? (def as ExtensionToolDef).planning
              : undefined,
            execute: def.execute as ExtensionToolDef['execute'],
          })
        }
      },
      registerCommand: () => { /* Commands stored as tools */ },
      registerService: () => { /* Services not yet supported in SwarmClaw */ },
      registerProvider: () => { /* Providers not yet bridged */ },
      registerChannel: () => { /* Channels not yet bridged */ },
      registerGatewayMethod: () => { /* RPC not supported */ },
      registerCli: () => { /* CLI not supported */ },
      logger: extensionLogger,
      log: extensionLogger,
      config: {},
      runtime: {},
    }

    try {
      registerFn(api)
    } catch (err: unknown) {
      log.error('extensions', 'OpenClaw register() failed', {
        extensionName,
        error: errorMessage(err),
      })
      return null
    }

    return {
      name: extensionName,
      version: extensionVersion,
      description: extensionDesc || `OpenClaw extension (v${extensionVersion})`,
      author: typeof raw.author === 'string' ? raw.author : undefined,
      openclaw: true,
      hooks,
      tools,
    }
  }

  // --- Legacy OpenClaw format: activate(ctx)/deactivate() ---
  if (raw.name && typeof raw.activate === 'function') {
    const oc = raw as unknown as OpenClawLegacyExtension
    const hooks: ExtensionHooks = {}
    const tools: ExtensionToolDef[] = []

    const registrar = {
      onAgentStart: (fn: (...args: unknown[]) => unknown) => { hooks.beforeAgentStart = fn as ExtensionHooks['beforeAgentStart'] },
      onAgentComplete: (fn: (...args: unknown[]) => unknown) => { hooks.afterAgentComplete = fn as ExtensionHooks['afterAgentComplete'] },
      onBeforePromptBuild: (fn: (...args: unknown[]) => unknown) => { hooks.beforePromptBuild = fn as ExtensionHooks['beforePromptBuild'] },
      onBeforeToolCall: (fn: (...args: unknown[]) => unknown) => { hooks.beforeToolCall = fn as ExtensionHooks['beforeToolCall'] },
      onToolCall: (fn: (...args: unknown[]) => unknown) => { hooks.beforeToolExec = fn as ExtensionHooks['beforeToolExec'] },
      onToolResult: (fn: (...args: unknown[]) => unknown) => { hooks.afterToolExec = fn as ExtensionHooks['afterToolExec'] },
      onMessage: (fn: (...args: unknown[]) => unknown) => { hooks.onMessage = fn as ExtensionHooks['onMessage'] },
      registerTool: (def: ExtensionToolDef) => { if (def?.name) tools.push(def) },
      log: {
        info: (msg: string, m?: unknown) => log.info(`extension:${oc.name}`, msg, m),
        warn: (msg: string, m?: unknown) => log.warn(`extension:${oc.name}`, msg, m),
        error: (msg: string, m?: unknown) => log.error(`extension:${oc.name}`, msg, m),
      }
    }

    try {
      oc.activate(registrar)
    } catch (err: unknown) {
      log.error('extensions', 'OpenClaw activate() failed', {
        extensionName: oc.name,
        error: errorMessage(err),
      })
      return null
    }

    return {
      name: oc.name,
      version: oc.version,
      description: `OpenClaw extension (v${oc.version || '0.0.0'})`,
      openclaw: true,
      hooks,
      tools,
    }
  }
  return null
}

interface LoadedExtension {
  id: string
  meta: ExtensionMeta
  hooks: ExtensionHooks
  tools: ExtensionToolDef[]
  ui?: ExtensionUIDefinition
  providers?: ExtensionProviderDefinition[]
  connectors?: ExtensionConnectorDefinition[]
  isBuiltin?: boolean
}

function createExtensionRequire(): NodeRequire | null {
  try {
    return createRequire(path.join(process.cwd(), 'package.json'))
  } catch (err: unknown) {
    log.warn('extensions', 'createRequire failed; external extensions disabled', {
      error: errorMessage(err),
    })
    return null
  }
}

export interface ExternalExtensionToolEntry {
  extensionId: string
  extensionName: string
  tool: ExtensionToolDef
}

class ExtensionManager {
  private extensions: Map<string, LoadedExtension> = new Map()
  private builtins: Map<string, Extension> = new Map()
  private loaded = false
  private watcher: fs.FSWatcher | null = null

  registerBuiltin(id: string, extension: Extension) {
    const canonicalId = this.canonicalExtensionId(id)
    this.builtins.set(canonicalId, extension)
    // Builtins can be imported/registered after first load, so force re-evaluation.
    this.loaded = false
  }

  private ensureExtensionWatcher(): void {
    if (this.watcher) return
    try {
      this.ensureExtensionDirs()
      const watcher = fs.watch(EXTENSIONS_DIR, (_eventType, filename) => {
        if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.mjs'))) return
        this.loaded = false
        notify('extensions')
      })
      watcher.on('error', (err: unknown) => {
        log.warn('extensions', 'Extension watcher disabled after runtime watch failure', {
          error: errorMessage(err),
        })
        if (this.watcher === watcher) {
          try { watcher.close() } catch { /* ignore */ }
          this.watcher = null
        }
      })
      watcher.unref?.()
      this.watcher = watcher
    } catch (err: unknown) {
      log.warn('extensions', 'Failed to watch extensions directory', {
        error: errorMessage(err),
      })
    }
  }

  private isExternalExtensionFilename(id: string): boolean {
    return id.endsWith('.js') || id.endsWith('.mjs')
  }

  private ensureExtensionDirs(): void {
    _migrateLegacyPaths()
    if (!fs.existsSync(EXTENSIONS_DIR)) fs.mkdirSync(EXTENSIONS_DIR, { recursive: true })
    if (!fs.existsSync(EXTENSION_WORKSPACES_DIR)) fs.mkdirSync(EXTENSION_WORKSPACES_DIR, { recursive: true })
  }

  private getWorkspaceDir(filename: string): string {
    return path.join(EXTENSION_WORKSPACES_DIR, extensionWorkspaceKey(filename))
  }

  private getWorkspaceEntryPath(filename: string): string {
    return path.join(this.getWorkspaceDir(filename), 'index.js')
  }

  private getWorkspaceManifestPath(filename: string): string {
    return path.join(this.getWorkspaceDir(filename), 'package.json')
  }

  private hasWorkspace(filename: string): boolean {
    return fs.existsSync(this.getWorkspaceEntryPath(filename))
  }

  private readWorkspaceManifest(filename: string): Record<string, unknown> | null {
    const manifestPath = this.getWorkspaceManifestPath(filename)
    try {
      if (!fs.existsSync(manifestPath)) return null
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private getDependencyInfo(filename: string, explicitConfig?: ExtensionConfigEntry | null): ExtensionDependencyInfo {
    const manifest = this.readWorkspaceManifest(filename)
    const counts = countManifestDependencies(manifest)
    return {
      hasManifest: !!manifest,
      dependencyCount: counts.dependencyCount,
      devDependencyCount: counts.devDependencyCount,
      packageManager:
        normalizeExtensionPackageManager(explicitConfig?.packageManager)
        || normalizeExtensionPackageManager(manifest?.packageManager)
        || undefined,
      installStatus: explicitConfig?.dependencyInstallStatus || (manifest ? 'ready' : 'none'),
      installError: explicitConfig?.dependencyInstallError,
      installedAt: explicitConfig?.dependencyInstalledAt,
    }
  }

  private writeWorkspaceShim(filename: string): void {
    const relEntry = `./.workspaces/${extensionWorkspaceKey(filename)}/index.js`
    const shim = `// Auto-generated extension workspace shim. Edit the managed source file instead.\nmodule.exports = require(${JSON.stringify(relEntry)})\n`
    fs.writeFileSync(path.join(EXTENSIONS_DIR, filename), shim, 'utf8')
  }

  private clearExtensionRequireCache(dynamicRequire: NodeRequire, filename: string): void {
    const rootPath = path.join(EXTENSIONS_DIR, filename)
    delete dynamicRequire.cache[rootPath]
    const workspaceDir = this.getWorkspaceDir(filename)
    for (const cacheKey of Object.keys(dynamicRequire.cache)) {
      if (cacheKey.startsWith(`${workspaceDir}${path.sep}`)) {
        delete dynamicRequire.cache[cacheKey]
      }
    }
  }

  private resolveExtensionSourcePath(filename: string): string {
    return this.hasWorkspace(filename)
      ? this.getWorkspaceEntryPath(filename)
      : path.join(EXTENSIONS_DIR, filename)
  }

  private async runDependencyInstall(packageManager: ExtensionPackageManager, cwd: string): Promise<void> {
    const { command, args } = getInstallCommand(packageManager)

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      let stdout = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`${command} install timed out after ${Math.round(EXTENSION_INSTALL_TIMEOUT_MS / 1000)}s`))
      }, EXTENSION_INSTALL_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = trimProcessOutput(`${stdout}${chunk.toString()}`)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = trimProcessOutput(`${stderr}${chunk.toString()}`)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`${command} is not installed on this machine`))
          return
        }
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(trimProcessOutput(`${stderr}\n${stdout}`) || `${command} install exited ${code}`))
      })
    })
  }

  private canonicalExtensionId(id: string): string {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (!trimmed) return ''
    if (this.isExternalExtensionFilename(trimmed)) return path.basename(trimmed)
    return canonicalizeExtensionId(trimmed)
  }

  private configIdsFor(id: string): string[] {
    const canonicalId = this.canonicalExtensionId(id)
    if (!canonicalId) return []
    if (this.isExternalExtensionFilename(canonicalId)) return [canonicalId]
    const aliases = getExtensionAliases(canonicalId)
    const ids = new Set<string>([canonicalId, ...aliases])
    return Array.from(ids)
  }

  private readConfigEntry(id: string, config?: Record<string, ExtensionConfigEntry>): ExtensionConfigEntry | null {
    const cfg = config || this.loadConfig()
    let merged: ExtensionConfigEntry | null = null
    for (const key of this.configIdsFor(id)) {
      const entry = cfg[key]
      if (!entry) continue
      merged = { ...(merged || {}), ...entry }
      if (key === this.canonicalExtensionId(id)) break
    }
    return merged
  }

  private writeConfig(config: Record<string, ExtensionConfigEntry>): void {
    fs.writeFileSync(EXTENSIONS_CONFIG, JSON.stringify(config, null, 2))
  }

  private updateConfigEntry(id: string, patch: ExtensionConfigEntry | null): void {
    const canonicalId = this.canonicalExtensionId(id)
    const config = this.loadConfig()
    for (const key of this.configIdsFor(canonicalId)) {
      if (key !== canonicalId) delete config[key]
    }
    if (patch) {
      config[canonicalId] = { ...(config[canonicalId] || {}), ...patch }
    } else {
      delete config[canonicalId]
    }
    this.writeConfig(config)
  }

  private resolveEnabledFilter(enabledIds?: string[], includeAllWhenEmpty = false): Set<string> | null {
    if (!Array.isArray(enabledIds) || enabledIds.length === 0) {
      return includeAllWhenEmpty ? null : new Set<string>()
    }
    return new Set(expandExtensionIds(enabledIds))
  }

  private readFailureState(): Record<string, ExtensionFailureRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(EXTENSION_FAILURES, 'utf8')) as Record<string, ExtensionFailureRecord>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      // Prune records older than 7 days
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000
      const now = Date.now()
      let pruned = false
      for (const key of Object.keys(parsed)) {
        if (now - (parsed[key].lastFailedAt || 0) > maxAgeMs) {
          delete parsed[key]
          pruned = true
        }
      }
      if (pruned) this.writeFailureState(parsed)
      return parsed
    } catch {
      return {}
    }
  }

  private writeFailureState(state: Record<string, ExtensionFailureRecord>): void {
    try {
      fs.writeFileSync(EXTENSION_FAILURES, JSON.stringify(state, null, 2))
    } catch (err: unknown) {
      log.warn('extensions', 'Failed to persist extension failure state', { error: errorMessage(err) })
    }
  }

  private clearFailureState(id: string): void {
    const state = this.readFailureState()
    let changed = false
    for (const key of this.configIdsFor(id)) {
      if (!state[key]) continue
      delete state[key]
      changed = true
    }
    if (!changed) return
    this.writeFailureState(state)
  }

  private autoDisableExternalExtension(id: string, reason: string, failure: ExtensionFailureRecord): void {
    try {
      const current = this.readConfigEntry(id)
      if (current?.enabled === false) return
      this.updateConfigEntry(id, { ...(current || {}), enabled: false })
    } catch (err: unknown) {
      log.error('extensions', 'Failed to write extensions config while auto-disabling extension', {
        extensionId: id,
        error: errorMessage(err),
      })
      return
    }
    this.loaded = false

    log.error('extensions', 'Auto-disabled extension after repeated failures', {
      extensionId: id,
      failureCount: failure.count,
      threshold: MAX_CONSECUTIVE_EXTENSION_FAILURES,
      reason,
      lastError: failure.lastError,
      stage: failure.lastStage,
    })

    createNotification({
      type: 'warning',
      title: `Extension auto-disabled: ${id}`,
      message: `${reason}. It failed ${failure.count} times consecutively and was disabled for stability.`,
      actionLabel: 'Open Extensions',
      actionUrl: '/extensions',
      entityType: 'extension',
      entityId: id,
      dedupKey: `extension-auto-disabled:${id}`,
    })
    notify('extensions')
  }

  private markExtensionFailure(id: string, stage: string, err: unknown, disableEligible: boolean): void {
    const errorText = errorMessage(err)
    const state = this.readFailureState()
    const failureKey = this.canonicalExtensionId(id)
    const nextCount = (state[failureKey]?.count || 0) + 1
    const record: ExtensionFailureRecord = {
      count: nextCount,
      lastError: errorText,
      lastStage: stage,
      lastFailedAt: Date.now(),
    }
    state[failureKey] = record
    this.writeFailureState(state)

    log.warn('extensions', 'Extension failure recorded', {
      extensionId: id,
      stage,
      failureCount: nextCount,
      threshold: MAX_CONSECUTIVE_EXTENSION_FAILURES,
      error: errorText,
    })

    if (
      disableEligible
      && nextCount >= MAX_CONSECUTIVE_EXTENSION_FAILURES
      && !this.builtins.has(failureKey)
    ) {
      this.autoDisableExternalExtension(failureKey, `Extension failure at ${stage}`, record)
    }
  }

  private markExtensionSuccess(id: string): void {
    try {
      this.clearFailureState(id)
    } catch (err: unknown) {
      log.warn('extensions', 'markExtensionSuccess failed', { error: errorMessage(err), extensionId: id })
    }
  }

  load() {
    if (this.loaded) return
    this.extensions.clear()
    this.ensureExtensionWatcher()

    const config = this.loadConfig()

    // 1. Load Built-ins
    for (const [id, p] of this.builtins.entries()) {
      const explicitConfig = this.readConfigEntry(id, config)
      const isEnabled = explicitConfig != null ? explicitConfig.enabled !== false : p.enabledByDefault !== false
      if (isEnabled) {
        this.extensions.set(id, {
          id,
          meta: {
            name: p.name,
            description: p.description || '',
            filename: id,
            enabled: true,
            author: p.author || 'SwarmClaw',
            version: p.version || '1.0.0',
            source: 'local',
            sourceLabel: 'builtin',
            installSource: 'builtin',
            openclaw: p.openclaw === true,
          },
          hooks: buildExtensionHooks(id, p.name, p.hooks, p.tools),
          tools: p.tools || [],
          ui: p.ui,
          providers: p.providers,
          connectors: p.connectors,
          isBuiltin: true
        })
        this.markExtensionSuccess(id)
      }
    }

    // 2. Load External
    try {
      this.ensureExtensionDirs()
      const files = fs.readdirSync(EXTENSIONS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
      const dynamicRequire = createExtensionRequire()

      if (dynamicRequire) {
        for (const file of files) {
          try {
            const explicitConfig = this.readConfigEntry(file, config)
            const isEnabled = explicitConfig?.enabled !== false
            if (!isEnabled) continue

            const fullPath = path.join(EXTENSIONS_DIR, file)
            this.clearExtensionRequireCache(dynamicRequire, file)
            const ext = normalizeExtension(dynamicRequire(fullPath))
            if (!ext) {
              this.markExtensionFailure(file, 'load.normalize', 'Extension format unsupported or activate() failed', true)
              continue
            }

            this.extensions.set(file, {
              id: file,
              meta: {
                name: ext.name,
                description: ext.description || '',
                filename: file,
                enabled: true,
                author: ext.author,
                version: ext.version || '0.0.1',
                source: inferStoredExtensionSource(explicitConfig),
                sourceLabel: inferStoredPublisherSource(explicitConfig),
                installSource: inferStoredInstallSource(explicitConfig),
                sourceUrl: explicitConfig?.sourceUrl,
                openclaw: ext.openclaw === true,
              },
              hooks: buildExtensionHooks(file, ext.name, ext.hooks, ext.tools),
              tools: ext.tools || [],
              ui: ext.ui,
              providers: ext.providers,
              connectors: ext.connectors,
            })
            this.markExtensionSuccess(file)
          } catch (err: unknown) {
            log.error('extensions', 'Failed to load external extension', {
              extensionId: file,
              error: errorMessage(err),
            })
            this.markExtensionFailure(file, 'load.require', err, true)
          }
        }
      }
    } catch { /* ignore */ }

    this.loaded = true
  }

  getTools(enabledIds: string[]): Array<{ extensionId: string; tool: ExtensionToolDef }> {
    this.load()
    const all: Array<{ extensionId: string; tool: ExtensionToolDef }> = []
    const ids = new Set(expandExtensionIds(enabledIds))
    for (const [id, p] of this.extensions.entries()) {
      if (ids.has(id)) {
        const tools = Array.isArray(p.tools) ? p.tools : []
        for (const t of tools) {
          if (!t || typeof t.name !== 'string' || typeof t.execute !== 'function') continue
          all.push({ extensionId: id, tool: t })
        }
      }
    }
    return all
  }

  getExternalTools(): ExtensionToolDef[] {
    return this.getExternalToolEntries().map((entry) => entry.tool)
  }

  getExternalToolEntries(): ExternalExtensionToolEntry[] {
    this.load()
    const all: ExternalExtensionToolEntry[] = []
    for (const p of this.extensions.values()) {
      if (p.isBuiltin) continue
      const extensionTools = Array.isArray(p.tools) ? p.tools : []
      for (const tool of extensionTools) {
        if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') continue
        all.push({
          extensionId: p.id,
          extensionName: p.meta.name,
          tool,
        })
      }
    }
    return all
  }

  getProviders(): ExtensionProviderDefinition[] {
    this.load()
    const allProviders: ExtensionProviderDefinition[] = []
    for (const p of this.extensions.values()) {
      if (p.providers) allProviders.push(...p.providers)
    }
    return allProviders
  }

  getConnectors(): ExtensionConnectorDefinition[] {
    this.load()
    const allConnectors: ExtensionConnectorDefinition[] = []
    for (const p of this.extensions.values()) {
      if (p.connectors) allConnectors.push(...p.connectors)
    }
    return allConnectors
  }

  getUIExtensions(): ExtensionUIDefinition[] {
    this.load()
    const allUI: ExtensionUIDefinition[] = []
    for (const p of this.extensions.values()) {
      if (p.ui) allUI.push(p.ui)
    }
    return allUI
  }

  listExtensionIds(): string[] {
    this.load()
    return Array.from(this.extensions.keys())
  }

  async runHook<K extends keyof ExtensionHooks>(hookName: K, ctx: HookContext<K>, options?: HookExecutionOptions) {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          await (hook as (hookCtx: HookContext<K>) => Promise<unknown> | unknown)(ctx)
          this.markExtensionSuccess(id)
        } catch (err: unknown) {
          log.error('extensions', 'Extension hook failed', {
            extensionId: id,
            extensionName: p.meta.name,
            hookName: String(hookName),
            error: errorMessage(err),
          })
          this.markExtensionFailure(id, `hook.${String(hookName)}`, err, true)
        }
      }
    }
  }

  async runBeforePromptBuild(
    params: {
      session: Session
      prompt: string
      message: string
      history: import('@/types').Message[]
      messages: import('@/types').Message[]
    },
    options?: HookExecutionOptions,
  ): Promise<ExtensionPromptBuildResult | null> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let result: ExtensionPromptBuildResult | undefined

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforePromptBuild
      if (!hook) continue
      try {
        const next = await hook(params)
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          result = mergePromptBuildResults(result, next as ExtensionPromptBuildResult)
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforePromptBuild hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforePromptBuild', err, true)
      }
    }

    return result || null
  }

  async runBeforeModelResolve(
    params: {
      session: Session
      prompt: string
      message: string
      provider: Session['provider']
      model: string
      apiEndpoint?: string | null
    },
    options?: HookExecutionOptions,
  ): Promise<ExtensionModelResolveResult | null> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let result: ExtensionModelResolveResult | undefined

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforeModelResolve
      if (!hook) continue
      try {
        const next = await hook(params)
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          result = mergeModelResolveResults(result, next as ExtensionModelResolveResult)
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforeModelResolve hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforeModelResolve', err, true)
      }
    }

    return result || null
  }

  async runBeforeToolCall(
    params: {
      session: Session
      toolName: string
      input: Record<string, unknown> | null
      runId?: string
      toolCallId?: string
    },
    options?: HookExecutionOptions,
  ): Promise<{ input: Record<string, unknown> | null; blockReason: string | null; warning: string | null }> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentInput = params.input
    let blockReason: string | null = null
    let warning: string | null = null

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue

      const beforeToolCall = p.hooks.beforeToolCall
      if (beforeToolCall) {
        try {
          const result = await beforeToolCall({
            session: params.session,
            toolName: params.toolName,
            input: currentInput,
            runId: params.runId,
            toolCallId: params.toolCallId,
          })

          if (isToolCallControlResult(result)) {
            if (result.block === true) {
              blockReason = typeof result.blockReason === 'string' && result.blockReason.trim()
                ? result.blockReason.trim()
                : 'Tool call blocked by extension hook'
            }
            if (typeof result.warning === 'string' && result.warning.trim()) {
              warning = result.warning.trim()
            }
            currentInput = mergeToolCallInput(
              currentInput,
              isRecord(result.params)
                ? result.params
                : isRecord(result.input)
                  ? result.input
                  : result.input === null
                    ? null
                    : undefined,
            )
          } else if (result && typeof result === 'object' && !Array.isArray(result)) {
            currentInput = result as Record<string, unknown>
          }
          this.markExtensionSuccess(id)
        } catch (err: unknown) {
          log.error('extensions', 'beforeToolCall hook failed', {
            extensionId: id,
            extensionName: p.meta.name,
            toolName: params.toolName,
            error: errorMessage(err),
          })
          this.markExtensionFailure(id, 'hook.beforeToolCall', err, true)
        }
      }

      const beforeToolExec = p.hooks.beforeToolExec
      if (blockReason) break
      if (!beforeToolExec) {
        continue
      }
      try {
        const legacyResult = await beforeToolExec({ toolName: params.toolName, input: currentInput })
        if (legacyResult && typeof legacyResult === 'object' && !Array.isArray(legacyResult)) {
          currentInput = legacyResult as Record<string, unknown>
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforeToolExec hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          toolName: params.toolName,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforeToolExec', err, true)
      }

      if (blockReason) break
    }

    return { input: currentInput, blockReason, warning }
  }

  async runToolResultPersist(
    params: {
      session: Session
      message: Message
      toolName?: string
      toolCallId?: string
      isSynthetic?: boolean
    },
    options?: HookExecutionOptions,
  ): Promise<Message> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentMessage = params.message

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.toolResultPersist
      if (!hook) continue
      try {
        const result = await hook({
          session: params.session,
          message: currentMessage,
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          isSynthetic: params.isSynthetic,
        })
        if (isMessageLike(result)) {
          currentMessage = result
        } else if (isRecord(result) && isMessageLike(result.message)) {
          currentMessage = result.message
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'toolResultPersist hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.toolResultPersist', err, true)
      }
    }

    return currentMessage
  }

  async runBeforeMessageWrite(
    params: {
      session: Session
      message: Message
      phase?: 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'
      runId?: string
    },
    options?: HookExecutionOptions,
  ): Promise<{ message: Message; block: boolean }> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentMessage = params.message
    let block = false

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforeMessageWrite
      if (!hook) continue
      try {
        const result = await hook({
          session: params.session,
          message: currentMessage,
          phase: params.phase,
          runId: params.runId,
        })
        if (isMessageLike(result)) {
          currentMessage = result
        } else if (isBeforeMessageWriteResult(result)) {
          if (isMessageLike(result.message)) currentMessage = result.message
          if (result.block === true) {
            block = true
            this.markExtensionSuccess(id)
            break
          }
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'beforeMessageWrite hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.beforeMessageWrite', err, true)
      }
    }

    return { message: currentMessage, block }
  }

  async runSubagentSpawning(
    params: {
      parentSessionId?: string | null
      agentId: string
      agentName: string
      message: string
      cwd: string
      mode: 'run' | 'session'
      threadRequested: boolean
    },
    options?: HookExecutionOptions,
  ): Promise<ExtensionSubagentSpawningResult> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.subagentSpawning
      if (!hook) continue
      try {
        const result = await hook(params)
        if (isSubagentSpawningResult(result) && result.status === 'error') {
          this.markExtensionSuccess(id)
          return {
            status: 'error',
            error: typeof result.error === 'string' && result.error.trim()
              ? result.error.trim()
              : 'Subagent spawn blocked by extension hook',
          }
        }
        this.markExtensionSuccess(id)
      } catch (err: unknown) {
        log.error('extensions', 'subagentSpawning hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.subagentSpawning', err, true)
      }
    }

    return { status: 'ok' }
  }

  async runBeforeToolExec(
    params: { toolName: string; input: Record<string, unknown> | null },
    options?: HookExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.runBeforeToolCall(
      {
        session: {
          id: 'extension-hook-session',
          name: 'Extension Hook Session',
          cwd: process.cwd(),
          user: 'system',
          // Synthetic fallback used only when no real session context is available.
          provider: 'openai',
          model: 'synthetic-hook-context',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        toolName: params.toolName,
        input: params.input,
      },
      options,
    )
    return result.input
  }

  async transformText(
    hookName: 'transformInboundMessage' | 'transformOutboundMessage',
    params: { session: Session; text: string },
    options?: HookExecutionOptions,
  ): Promise<string> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentText = params.text

    for (const [id, p] of this.extensions.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          const result = await (hook as (ctx: typeof params) => Promise<string> | string)({ ...params, text: currentText })
          if (typeof result === 'string') currentText = result
          this.markExtensionSuccess(id)
        } catch (err: unknown) {
          log.error('extensions', 'Extension transform hook failed', {
            extensionId: id,
            extensionName: p.meta.name,
            hookName,
            error: errorMessage(err),
          })
          this.markExtensionFailure(id, `hook.${String(hookName)}`, err, true)
        }
      }
    }
    return currentText
  }

  async collectAgentContext(session: import('@/types').Session, enabledExtensions: string[], message: string, history: import('@/types').Message[]): Promise<string[]> {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const parts: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getAgentContext
      if (!hook) continue
      try {
        const result = await hook({ session, enabledExtensions, message, history })
        if (typeof result === 'string' && result.trim()) {
          parts.push(result)
          this.markExtensionSuccess(id)
        }
      } catch (err: unknown) {
        log.error('extensions', 'getAgentContext hook failed', {
          extensionId: id,
          extensionName: p.meta.name,
          error: errorMessage(err),
        })
        this.markExtensionFailure(id, 'hook.getAgentContext', err, true)
      }
    }

    return parts
  }

  /** Collect capability descriptions from all enabled extensions for system prompt */
  collectCapabilityDescriptions(enabledExtensions: string[]): string[] {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const lines: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getCapabilityDescription
      if (!hook) continue
      try {
        const result = hook()
        if (typeof result === 'string' && result.trim()) {
          lines.push(`- ${result}`)
        }
      } catch (err: unknown) {
        log.error('extensions', 'getCapabilityDescription hook failed', { extensionId: id, error: errorMessage(err) })
      }
    }

    return lines
  }

  /** Collect operating guidance from all enabled extensions */
  collectOperatingGuidance(enabledExtensions: string[]): string[] {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const lines: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getOperatingGuidance
      if (!hook) continue
      try {
        const result = hook()
        if (result === null || result === undefined) continue
        if (typeof result === 'string' && result.trim()) {
          lines.push(result)
        } else if (Array.isArray(result)) {
          for (const line of result) {
            if (typeof line === 'string' && line.trim()) lines.push(line)
          }
        }
      } catch (err: unknown) {
        log.error('extensions', 'getOperatingGuidance hook failed', { extensionId: id, error: errorMessage(err) })
      }
    }

    return lines
  }

  /** Collect approval guidance from all enabled extensions for a specific approval event */
  collectApprovalGuidance(
    enabledExtensions: string[],
    ctx: {
      approval: import('@/types').ApprovalRequest
      phase: 'request' | 'resume' | 'connector_reminder'
      approved?: boolean
    },
  ): string[] {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const lines: string[] = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getApprovalGuidance
      if (!hook) continue
      try {
        const result = hook(ctx)
        if (result === null || result === undefined) continue
        if (typeof result === 'string' && result.trim()) {
          lines.push(result)
        } else if (Array.isArray(result)) {
          for (const line of result) {
            if (typeof line === 'string' && line.trim()) lines.push(line)
          }
        }
      } catch (err: unknown) {
        log.error('extensions', 'getApprovalGuidance hook failed', {
          extensionId: id,
          error: errorMessage(err),
        })
      }
    }

    return lines
  }

  /** Collect all settings fields declared by enabled extensions */
  collectSettingsFields(enabledExtensions: string[]): Array<{ extensionId: string; extensionName: string; fields: import('@/types').ExtensionSettingsField[] }> {
    this.load()
    const enabledSet = new Set(expandExtensionIds(enabledExtensions))
    const result: Array<{ extensionId: string; extensionName: string; fields: import('@/types').ExtensionSettingsField[] }> = []

    for (const [id, p] of this.extensions.entries()) {
      if (!enabledSet.has(id)) continue
      const fields = p.ui?.settingsFields
      if (fields?.length) {
        result.push({ extensionId: id, extensionName: p.meta.name, fields })
      }
    }

    return result
  }

  getSettingsFields(extensionId: string): import('@/types').ExtensionSettingsField[] {
    this.load()
    const candidateIds = expandExtensionIds([extensionId])
    for (const id of candidateIds) {
      const ext = this.extensions.get(id) || (this.builtins.has(id) ? {
        ui: this.builtins.get(id)?.ui,
      } as LoadedExtension : null)
      const fields = ext?.ui?.settingsFields
      if (fields?.length) return fields
    }
    return []
  }

  getExtensionSettings(extensionId: string): Record<string, unknown> {
    const settings = loadSettings()
    const allSettings = (settings.extensionSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    const result: Record<string, unknown> = {}

    for (const key of this.configIdsFor(extensionId)) {
      const values = allSettings[key]
      if (!values || typeof values !== 'object') continue
      for (const [fieldKey, fieldValue] of Object.entries(values)) {
        if (isExtensionSecretSettingValue(fieldValue)) {
          try {
            result[fieldKey] = decryptKey(fieldValue.encrypted)
          } catch {
            result[fieldKey] = ''
          }
          continue
        }
        result[fieldKey] = fieldValue
      }
    }

    for (const field of this.getSettingsFields(extensionId)) {
      if (result[field.key] === undefined && field.defaultValue !== undefined) {
        result[field.key] = field.defaultValue
      }
    }

    return result
  }

  getPublicExtensionSettings(extensionId: string): { values: Record<string, unknown>; configuredSecretFields: string[] } {
    const values = this.getExtensionSettings(extensionId)
    const configuredSecretFields: string[] = []

    for (const field of this.getSettingsFields(extensionId)) {
      if (field.type !== 'secret') continue
      const current = values[field.key]
      if (typeof current === 'string' && current.trim()) {
        configuredSecretFields.push(field.key)
      }
      values[field.key] = ''
    }

    return { values, configuredSecretFields }
  }

  setExtensionSettings(extensionId: string, values: Record<string, unknown>): Record<string, unknown> {
    const fields = this.getSettingsFields(extensionId)
    if (fields.length === 0 && Object.keys(values || {}).length > 0) {
      throw new Error(`Extension "${extensionId}" does not declare configurable settings`)
    }
    const fieldMap = new Map(fields.map((field) => [field.key, field]))
    const nextValues: Record<string, unknown> = {}

    for (const [key, rawValue] of Object.entries(values || {})) {
      const field = fieldMap.get(key)
      if (!field) continue
      if (rawValue === undefined) continue
      if (field.type === 'boolean') {
        nextValues[key] = rawValue === true || rawValue === 'true' || rawValue === 1 || rawValue === '1'
        continue
      }
      if (field.type === 'number') {
        const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue)
        if (!Number.isFinite(parsed)) throw new Error(`Invalid number for setting "${key}"`)
        nextValues[key] = parsed
        continue
      }
      const text = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '')
      if (field.required && !text.trim()) throw new Error(`Setting "${key}" is required`)
      if (field.type === 'select' && field.options?.length) {
        const allowed = new Set(field.options.map((option) => option.value))
        if (!allowed.has(text)) throw new Error(`Invalid value for setting "${key}"`)
      }
      if (field.type === 'secret') {
        nextValues[key] = text.trim()
      } else {
        nextValues[key] = text
      }
    }

    const currentSettings = loadSettings()
    const settingsMap = (currentSettings.extensionSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    const canonicalId = this.canonicalExtensionId(extensionId)
    const existingStored: Record<string, unknown> = {}
    for (const alias of this.configIdsFor(canonicalId)) {
      const existing = settingsMap[alias]
      if (!existing || typeof existing !== 'object') continue
      Object.assign(existingStored, existing)
    }

    for (const field of fields) {
      if (!field.required) continue
      if (
        nextValues[field.key] === undefined
        && existingStored[field.key] === undefined
        && field.defaultValue === undefined
      ) {
        throw new Error(`Setting "${field.key}" is required`)
      }
    }

    const stored: Record<string, unknown> = {}

    for (const field of fields) {
      if (nextValues[field.key] === undefined) {
        if (existingStored[field.key] !== undefined) {
          stored[field.key] = existingStored[field.key]
        }
        continue
      }
      if (field.type === 'secret') {
        stored[field.key] = {
          __extensionSecret: true,
          encrypted: encryptKey(String(nextValues[field.key] ?? '')),
        } satisfies ExtensionSecretSettingValue
      } else {
        stored[field.key] = nextValues[field.key]
      }
    }

    for (const alias of this.configIdsFor(canonicalId)) {
      delete settingsMap[alias]
    }
    settingsMap[canonicalId] = stored
    currentSettings.extensionSettings = settingsMap
    saveSettings(currentSettings)

    return this.getPublicExtensionSettings(canonicalId).values
  }

  recordExternalToolFailure(extensionId: string, toolName: string, err: unknown): void {
    this.markExtensionFailure(extensionId, `tool.${toolName}`, err, true)
  }

  recordExternalToolSuccess(extensionId: string): void {
    this.markExtensionSuccess(extensionId)
  }

  isEnabled(filename: string): boolean {
    const explicit = this.readConfigEntry(filename)
    if (explicit != null) return explicit.enabled !== false
    const builtin = this.builtins.get(this.canonicalExtensionId(filename))
    if (builtin) return builtin.enabledByDefault !== false
    return true
  }

  isExplicitlyDisabled(filename: string): boolean {
    const explicit = this.readConfigEntry(filename)
    return explicit?.enabled === false
  }

  listExtensions(): ExtensionMeta[] {
    try {
      this.load()
      const config = this.loadConfig()
      const failures = this.readFailureState()
      const metas: ExtensionMeta[] = []

      const describeCapabilities = (loaded?: LoadedExtension, fallback?: Extension): Pick<ExtensionMeta, 'toolCount' | 'hookCount' | 'hasUI' | 'providerCount' | 'connectorCount' | 'settingsFields'> => {
        const tools = loaded?.tools || fallback?.tools || []
        const hooks = loaded?.hooks || fallback?.hooks || {}
        const providers = loaded?.providers || fallback?.providers || []
        const connectors = loaded?.connectors || fallback?.connectors || []
        const hasUi = !!(loaded?.ui || fallback?.ui)
        const settingsFields = loaded?.ui?.settingsFields || fallback?.ui?.settingsFields
        return {
          toolCount: Array.isArray(tools) ? tools.length : 0,
          hookCount: Object.values(hooks || {}).filter((fn) => typeof fn === 'function').length,
          hasUI: hasUi,
          providerCount: Array.isArray(providers) ? providers.length : 0,
          connectorCount: Array.isArray(connectors) ? connectors.length : 0,
          settingsFields: settingsFields?.length ? settingsFields : undefined,
        }
      }

      // Add all builtins
      for (const [id, p] of this.builtins.entries()) {
        const loaded = this.extensions.get(id)
        const explicitCfg = this.readConfigEntry(id, config)
        const enabled = explicitCfg != null ? explicitCfg.enabled !== false : p.enabledByDefault !== false
        const failure = failures[this.canonicalExtensionId(id)]
        const caps = describeCapabilities(loaded, p)
        metas.push({
          name: p.name,
          description: p.description || '',
          filename: id,
          enabled,
          isBuiltin: true,
          author: p.author || 'SwarmClaw',
          version: (p as { version?: string }).version || loaded?.meta.version || '1.0.0',
          source: loaded?.meta.source || 'local',
          sourceLabel: 'builtin',
          installSource: 'builtin',
          sourceUrl: loaded?.meta.sourceUrl,
          openclaw: p.openclaw === true,
          failureCount: failure?.count,
          lastFailureAt: failure?.lastFailedAt,
          lastFailureStage: failure?.lastStage,
          lastFailureError: failure?.lastError,
          autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_EXTENSION_FAILURES,
          ...caps,
        })
      }

      // Add external files
      try {
        const files = fs.readdirSync(EXTENSIONS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
        for (const f of files) {
          if (!metas.find(m => m.filename === f)) {
            const loaded = this.extensions.get(f)
            const explicitCfg = this.readConfigEntry(f, config)
            const enabled = explicitCfg?.enabled !== false
            const failure = failures[f]
            const caps = describeCapabilities(loaded)
            const dependencyInfo = this.getDependencyInfo(f, explicitCfg)
            metas.push({
              name: loaded?.meta.name || f.replace(/\.(js|mjs)$/, ''),
              filename: f,
              enabled,
              isBuiltin: false,
              author: loaded?.meta.author,
              version: loaded?.meta.version || '0.0.1',
              source: loaded?.meta.source || inferStoredExtensionSource(explicitCfg),
              sourceLabel: loaded?.meta.sourceLabel || inferStoredPublisherSource(explicitCfg),
              installSource: loaded?.meta.installSource || inferStoredInstallSource(explicitCfg),
              sourceUrl: loaded?.meta.sourceUrl || explicitCfg?.sourceUrl,
              openclaw: loaded?.meta.openclaw,
              createdByAgentId: explicitCfg?.createdByAgentId || null,
              failureCount: failure?.count,
              lastFailureAt: failure?.lastFailedAt,
              lastFailureStage: failure?.lastStage,
              lastFailureError: failure?.lastError,
              autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_EXTENSION_FAILURES,
              hasDependencyManifest: dependencyInfo.hasManifest,
              dependencyCount: dependencyInfo.dependencyCount,
              devDependencyCount: dependencyInfo.devDependencyCount,
              packageManager: dependencyInfo.packageManager,
              dependencyInstallStatus: dependencyInfo.installStatus,
              dependencyInstallError: dependencyInfo.installError,
              dependencyInstalledAt: dependencyInfo.installedAt,
              ...caps,
            })
          }
        }
      } catch { /* ignore */ }

      return metas
    } catch (err: unknown) {
      log.error('extensions', 'listExtensions failed', { error: errorMessage(err) })
      return []
    }
  }

  readExtensionSource(filename: string): string {
    const fullPath = this.resolveExtensionSourcePath(filename)
    if (!fs.existsSync(fullPath)) throw new Error(`Extension not found: ${filename}`)
    return fs.readFileSync(fullPath, 'utf8')
  }

  async saveExtensionSource(filename: string, code: string, options?: UpsertExtensionOptions): Promise<void> {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    this.ensureExtensionDirs()

    const shouldUseWorkspace = this.hasWorkspace(sanitizedFilename) || options?.packageJson !== undefined
    const sourcePath = shouldUseWorkspace
      ? this.getWorkspaceEntryPath(sanitizedFilename)
      : path.join(EXTENSIONS_DIR, sanitizedFilename)

    if (shouldUseWorkspace) {
      fs.mkdirSync(this.getWorkspaceDir(sanitizedFilename), { recursive: true })
      fs.writeFileSync(sourcePath, code, 'utf8')
      this.writeWorkspaceShim(sanitizedFilename)
    } else {
      fs.writeFileSync(sourcePath, code, 'utf8')
    }

    const normalizedPackageManager = normalizeExtensionPackageManager(options?.packageManager)

    if (options?.packageJson !== undefined) {
      if (!shouldUseWorkspace) {
        throw new Error('Extension workspace is required for package.json support')
      }
      const manifest = normalizeExtensionManifest(options.packageJson, sanitizedFilename, normalizedPackageManager)
      fs.writeFileSync(this.getWorkspaceManifestPath(sanitizedFilename), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      this.setMeta(sanitizedFilename, {
        ...(options?.meta || {}),
        packageManager: normalizedPackageManager || normalizeExtensionPackageManager(manifest.packageManager) || undefined,
        dependencyInstallStatus: 'ready',
        dependencyInstallError: undefined,
        dependencyInstalledAt: undefined,
      })
    } else if (options?.meta && Object.keys(options.meta).length > 0) {
      this.setMeta(sanitizedFilename, options.meta)
    }

    if (options?.installDependencies) {
      await this.installExtensionDependencies(sanitizedFilename, {
        packageManager: normalizedPackageManager || undefined,
      })
    }

    this.reload()
  }

  async installExtensionDependencies(filename: string, options?: { packageManager?: ExtensionPackageManager }): Promise<ExtensionDependencyInfo> {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const fullPath = path.join(EXTENSIONS_DIR, sanitizedFilename)
    if (!fs.existsSync(fullPath) && !this.hasWorkspace(sanitizedFilename)) {
      throw new Error(`Extension not found: ${sanitizedFilename}`)
    }

    this.ensureExtensionDirs()
    const workspaceDir = this.getWorkspaceDir(sanitizedFilename)
    const sourcePath = this.resolveExtensionSourcePath(sanitizedFilename)
    const currentCode = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : ''

    if (!this.hasWorkspace(sanitizedFilename)) {
      fs.mkdirSync(workspaceDir, { recursive: true })
      fs.writeFileSync(this.getWorkspaceEntryPath(sanitizedFilename), currentCode, 'utf8')
      this.writeWorkspaceShim(sanitizedFilename)
    }

    const manifest = this.readWorkspaceManifest(sanitizedFilename)
    if (!manifest) throw new Error(`Extension "${sanitizedFilename}" does not have a package.json manifest`)

    const packageManager = options?.packageManager
      || normalizeExtensionPackageManager(this.readConfigEntry(sanitizedFilename)?.packageManager)
      || normalizeExtensionPackageManager(manifest.packageManager)
      || 'npm'

    this.setMeta(sanitizedFilename, {
      packageManager,
      dependencyInstallStatus: 'installing',
      dependencyInstallError: undefined,
    })

    try {
      await this.runDependencyInstall(packageManager, workspaceDir)
      this.setMeta(sanitizedFilename, {
        packageManager,
        dependencyInstallStatus: 'installed',
        dependencyInstallError: undefined,
        dependencyInstalledAt: Date.now(),
      })
    } catch (err: unknown) {
      const message = errorMessage(err)
      this.setMeta(sanitizedFilename, {
        packageManager,
        dependencyInstallStatus: 'error',
        dependencyInstallError: message,
      })
      throw new Error(message)
    } finally {
      this.reload()
    }

    return this.getDependencyInfo(sanitizedFilename, this.readConfigEntry(sanitizedFilename))
  }

  setEnabled(filename: string, enabled: boolean) {
    const current = this.readConfigEntry(filename)
    this.updateConfigEntry(filename, { ...(current || {}), enabled })
    if (enabled) this.clearFailureState(filename)
    this.reload()
  }

  deleteExtension(filename: string): boolean {
    // Only allow deleting external extensions, not builtins
    if (this.builtins.has(this.canonicalExtensionId(filename))) return false
    const fullPath = path.join(EXTENSIONS_DIR, filename)
    if (!fs.existsSync(fullPath)) return false
    fs.unlinkSync(fullPath)
    const workspaceDir = this.getWorkspaceDir(filename)
    if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true })
    this.updateConfigEntry(filename, null)
    const settings = loadSettings()
    const settingsMap = (settings.extensionSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    for (const key of this.configIdsFor(filename)) delete settingsMap[key]
    settings.extensionSettings = settingsMap
    saveSettings(settings)
    this.clearFailureState(filename)
    this.reload()
    return true
  }

  async installExtensionFromUrl(url: string, filename: string, meta?: Record<string, unknown>): Promise<InstalledExtensionSource> {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const download = await downloadExtensionSource(url)
    await this.saveExtensionSource(sanitizedFilename, download.code, {
      meta: {
        ...(meta || {}),
        sourceUrl: download.normalizedUrl,
        sourceHash: download.hash,
        installedAt: Date.now(),
        updatedAt: Date.now(),
      },
    })

    return {
      filename: sanitizedFilename,
      sourceUrl: download.normalizedUrl,
      sourceHash: download.hash,
      contentType: download.contentType,
    }
  }

  async updateExtension(id: string) {
    this.load()
    const p = this.extensions.get(id)
    if (!p) throw new Error('Extension not found')
    if (p.isBuiltin) throw new Error('Built-in extensions are updated via application releases')

    log.info('extensions', 'Updating extension', { extensionId: id, extensionName: p.meta.name })
    const current = this.readConfigEntry(id)
    const sourceUrl = current?.sourceUrl?.trim()
    if (!sourceUrl) throw new Error(`Extension "${id}" has no recorded source URL and cannot be updated automatically`)

    const download = await downloadExtensionSource(sourceUrl)
    const fullPath = path.join(EXTENSIONS_DIR, id)
    fs.writeFileSync(fullPath, download.code, 'utf8')
    this.setMeta(id, {
      sourceUrl: download.normalizedUrl,
      sourceHash: download.hash,
      updatedAt: Date.now(),
    })

    this.reload()
    return true
  }

  async updateAllExtensions() {
    this.load()
    const ids = Array.from(this.extensions.entries())
      .filter(([, entry]) => !entry.isBuiltin)
      .map(([id]) => id)
    for (const id of ids) {
      try {
        await this.updateExtension(id)
      } catch { /* ignore individual failures */ }
    }
    return true
  }

  setMeta(filename: string, meta: Record<string, unknown>) {
    const current = this.readConfigEntry(filename)
    this.updateConfigEntry(filename, { ...(current || {}), ...(meta as ExtensionConfigEntry) })
  }

  private loadConfig(): Record<string, ExtensionConfigEntry> {
    try { return JSON.parse(fs.readFileSync(EXTENSIONS_CONFIG, 'utf8')) } catch { return {} }
  }

  reload() { this.loaded = false; this.load() }
}

const _managerHolder = hmrSingleton<{ instance: ExtensionManager | null }>('__swarmclaw_extension_manager__', () => ({ instance: null }))
export function getExtensionManager(): ExtensionManager {
  try {
    if (!_managerHolder.instance) {
      _managerHolder.instance = new ExtensionManager()
    }
    return _managerHolder.instance
  } catch (err: unknown) {
    log.error('extensions', 'getExtensionManager critical failure', { error: errorMessage(err) })
    throw err
  }
}
