import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import type { Plugin, PluginHooks, PluginMeta, PluginToolDef, PluginUIExtension, PluginProviderExtension, PluginConnectorExtension, Session, PluginPackageManager, PluginDependencyInstallStatus } from '@/types'
import { DATA_DIR } from './data-dir'
import { canonicalizePluginId, expandPluginIds, getPluginAliases } from './tool-aliases'
import { log } from './logger'
import { createNotification } from './create-notification'
import { notify } from './ws-hub'
import { decryptKey, encryptKey, loadSettings, saveSettings } from './storage'

const PLUGINS_DIR = path.join(DATA_DIR, 'plugins')
const PLUGIN_WORKSPACES_DIR = path.join(PLUGINS_DIR, '.workspaces')
const PLUGINS_CONFIG = path.join(DATA_DIR, 'plugins.json')
const PLUGIN_FAILURES = path.join(DATA_DIR, 'plugin-failures.json')
const MAX_EXTERNAL_PLUGIN_BYTES = 1024 * 1024
const SUPPORTED_PLUGIN_PACKAGE_MANAGERS: PluginPackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']
const PACKAGE_INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CONSECUTIVE_PLUGIN_FAILURES = (() => {
  const raw = Number.parseInt(process.env.SWARMCLAW_PLUGIN_FAILURE_THRESHOLD || '3', 10)
  if (!Number.isFinite(raw)) return 3
  return Math.max(2, Math.min(20, raw))
})()

interface PluginFailureRecord {
  count: number
  lastError: string
  lastStage: string
  lastFailedAt: number
}

interface PluginConfigEntry {
  enabled?: boolean
  createdByAgentId?: string
  sourceUrl?: string
  sourceHash?: string
  installedAt?: number
  updatedAt?: number
  packageManager?: PluginPackageManager
  dependencyInstallStatus?: PluginDependencyInstallStatus
  dependencyInstallError?: string
  dependencyInstalledAt?: number
}

interface InstalledPluginSource {
  filename: string
  sourceUrl: string
  sourceHash: string
  contentType?: string
}

interface PluginSourceDownload {
  code: string
  contentType: string
  normalizedUrl: string
  hash: string
}

interface PluginDependencyInfo {
  hasManifest: boolean
  dependencyCount: number
  devDependencyCount: number
  packageManager?: PluginPackageManager
  installStatus: PluginDependencyInstallStatus
  installError?: string
  installedAt?: number
}

interface UpsertPluginOptions {
  packageJson?: unknown
  packageManager?: string | null
  installDependencies?: boolean
  meta?: Record<string, unknown>
}

interface PluginSecretSettingValue {
  __pluginSecret: true
  encrypted: string
}

interface PluginLogger {
  info: (msg: string, m?: unknown) => void
  warn: (msg: string, m?: unknown) => void
  error: (msg: string, m?: unknown) => void
}

type HookRegistrar = {
  onAgentStart?: (fn: (...args: unknown[]) => unknown) => void
  onAgentComplete?: (fn: (...args: unknown[]) => unknown) => void
  onToolCall?: (fn: (...args: unknown[]) => unknown) => void
  onToolResult?: (fn: (...args: unknown[]) => unknown) => void
  onMessage?: (fn: (...args: unknown[]) => unknown) => void
}

type HookContext<K extends keyof PluginHooks> =
  PluginHooks[K] extends ((ctx: infer C) => unknown) | undefined ? C : never

/** Legacy OpenClaw format: activate(ctx)/deactivate() */
interface OpenClawLegacyPlugin {
  name: string
  version?: string
  activate: (ctx: HookRegistrar & { registerTool: (def: PluginToolDef) => void; log: PluginLogger }) => void
  deactivate?: () => void
}

/**
 * Real OpenClaw plugin format: function export `(api) => {}` or object with `register(api)`.
 * Supports api.registerHook(), api.registerTool(), api.registerCommand(), api.registerService().
 */
interface OpenClawPluginApi {
  registerHook: (event: string, handler: (...args: unknown[]) => unknown, meta?: { name?: string; description?: string }) => void
  registerTool: (def: PluginToolDef | { name: string; description?: string; parameters?: Record<string, unknown>; planning?: PluginToolDef['planning']; execute: (...args: unknown[]) => unknown }) => void
  registerCommand: (def: { name: string; description?: string; handler: (...args: unknown[]) => unknown }) => void
  registerService: (def: { id: string; start: () => void; stop?: () => void }) => void
  registerProvider: (def: Record<string, unknown>) => void
  registerChannel: (def: Record<string, unknown>) => void
  registerGatewayMethod: (name: string, handler: (...args: unknown[]) => unknown) => void
  registerCli: (fn: (...args: unknown[]) => unknown, meta?: { commands?: string[] }) => void
  logger: PluginLogger
  log: PluginLogger
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

function isPluginSecretSettingValue(value: unknown): value is PluginSecretSettingValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  return rec.__pluginSecret === true && typeof rec.encrypted === 'string'
}

function hashPluginSource(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function normalizePluginPackageManager(raw: unknown): PluginPackageManager | null {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!text) return null
  const normalized = text.split('@')[0] as PluginPackageManager
  return SUPPORTED_PLUGIN_PACKAGE_MANAGERS.includes(normalized) ? normalized : null
}

function pluginWorkspaceKey(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function trimProcessOutput(output: string): string {
  return output.trim().slice(-4000)
}

function normalizePluginManifest(
  rawManifest: unknown,
  filename: string,
  packageManager?: PluginPackageManager | null,
): Record<string, unknown> {
  const parsed = typeof rawManifest === 'string'
    ? JSON.parse(rawManifest) as unknown
    : rawManifest
  if (!isRecord(parsed)) throw new Error('Plugin package.json must be a JSON object')

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

function getInstallCommand(packageManager: PluginPackageManager): { command: string; args: string[] } {
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

function toRawPluginUrl(url: string): string {
  if (url.includes('github.com') && url.includes('/blob/')) {
    return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
  }
  if (url.includes('gist.github.com')) {
    return url.endsWith('/raw') ? url : `${url}/raw`
  }
  return url
}

export function normalizeMarketplacePluginUrl(url: string): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) return trimmed

  let normalized = trimmed
    .replace('github.com/swarmclawai/plugins/', 'github.com/swarmclawai/swarmforge/')
    .replace('raw.githubusercontent.com/swarmclawai/plugins/', 'raw.githubusercontent.com/swarmclawai/swarmforge/')

  normalized = toRawPluginUrl(normalized)

  return normalized
    .replace('/swarmclawai/swarmforge/master/', '/swarmclawai/swarmforge/main/')
    .replace('/swarmclawai/plugins/master/', '/swarmclawai/swarmforge/main/')
    .replace('/swarmclawai/plugins/main/', '/swarmclawai/swarmforge/main/')
}

export function sanitizePluginFilename(filename: string): string {
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

async function downloadPluginSource(url: string): Promise<PluginSourceDownload> {
  const normalizedUrl = normalizeMarketplacePluginUrl(url)
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
  if (Number.isFinite(declaredSize) && declaredSize > MAX_EXTERNAL_PLUGIN_BYTES) {
    throw new Error(`Plugin file is too large (${declaredSize} bytes)`)
  }

  let code = await res.text()
  if (Buffer.byteLength(code, 'utf8') > MAX_EXTERNAL_PLUGIN_BYTES) {
    throw new Error(`Plugin file exceeds ${MAX_EXTERNAL_PLUGIN_BYTES} bytes`)
  }

  if (contentType.includes('text/html') && code.includes('<!DOCTYPE')) {
    throw new Error('URL returned an HTML page instead of JavaScript. Use a raw/direct link to the plugin file.')
  }

  // Compatibility: modern Node exposes global fetch.
  code = code.replace(/const\s+fetch\s*=\s*require\(['"]node-fetch['"]\);?/g, '// node-fetch stripped for compatibility')
  code = code.replace(/import\s+fetch\s+from\s+['"]node-fetch['"];?/g, '// node-fetch stripped for compatibility')

  return {
    code,
    contentType,
    normalizedUrl,
    hash: hashPluginSource(code),
  }
}

function coerceTools(rawTools: unknown): PluginToolDef[] {
  if (Array.isArray(rawTools)) {
    const tools: PluginToolDef[] = []
    for (const rawTool of rawTools) {
      if (!isRecord(rawTool)) continue
      const name = typeof rawTool.name === 'string' ? rawTool.name.trim() : ''
      const execute = rawTool.execute
      if (!name || typeof execute !== 'function') continue
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : `Plugin tool: ${name}`,
        parameters: isRecord(rawTool.parameters) ? rawTool.parameters : { type: 'object', properties: {} },
        planning: isRecord(rawTool.planning) ? rawTool.planning as PluginToolDef['planning'] : undefined,
        execute: execute as PluginToolDef['execute'],
      })
    }
    return tools
  }

  // Compatibility: object-map format (e.g. { ping: () => 'pong' }).
  if (isRecord(rawTools)) {
    const tools: PluginToolDef[] = []
    for (const [name, rawTool] of Object.entries(rawTools)) {
      if (!name.trim()) continue
      if (typeof rawTool === 'function') {
        tools.push({
          name,
          description: `Plugin tool: ${name}`,
          parameters: { type: 'object', properties: {} },
          execute: async (args) => rawTool(args),
        })
        continue
      }
      if (!isRecord(rawTool) || typeof rawTool.execute !== 'function') continue
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : `Plugin tool: ${name}`,
        parameters: isRecord(rawTool.parameters) ? rawTool.parameters : { type: 'object', properties: {} },
        planning: isRecord(rawTool.planning) ? rawTool.planning as PluginToolDef['planning'] : undefined,
        execute: rawTool.execute as PluginToolDef['execute'],
      })
    }
    return tools
  }

  return []
}

function normalizePlugin(mod: unknown): Plugin | null {
  const modObj = mod as Record<string, unknown>
  const raw: Record<string, unknown> = (modObj?.default as Record<string, unknown>) || modObj

  if (raw.name && (raw.hooks || raw.tools || raw.ui || raw.providers || raw.connectors)) {
    const hooks = isRecord(raw.hooks) ? (raw.hooks as PluginHooks) : {}
    return {
      name: raw.name as string,
      version: (raw.version as string) || '0.0.1',
      description: (raw.description as string) || '',
      author: typeof raw.author === 'string' ? raw.author : undefined,
      openclaw: raw.openclaw === true,
      hooks,
      tools: coerceTools(raw.tools),
      ui: isRecord(raw.ui) ? (raw.ui as PluginUIExtension) : undefined,
      providers: Array.isArray(raw.providers) ? (raw.providers as PluginProviderExtension[]) : undefined,
      connectors: Array.isArray(raw.connectors) ? (raw.connectors as PluginConnectorExtension[]) : undefined,
    } as Plugin
  }

  // --- Real OpenClaw format: function export `(api) => {}` or object with `register(api)` ---
  const registerFn = typeof raw === 'function'
    ? raw as (api: OpenClawPluginApi) => void
    : typeof raw.register === 'function'
      ? raw.register as (api: OpenClawPluginApi) => void
      : typeof raw.default === 'function' && !raw.name && !raw.hooks
        ? raw.default as (api: OpenClawPluginApi) => void
        : null

  if (registerFn) {
    const pluginName = (raw.id || raw.name || 'openclaw-plugin') as string
    const pluginVersion = (raw.version || '1.0.0') as string
    const pluginDesc = (raw.description || '') as string
    const hooks: PluginHooks = {}
    const tools: PluginToolDef[] = []

    const hookEventMap: Record<string, keyof PluginHooks> = {
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

    const pluginLogger: PluginLogger = {
      info: (msg: string, m?: unknown) => log.info(`plugin:${pluginName}`, msg, m),
      warn: (msg: string, m?: unknown) => log.warn(`plugin:${pluginName}`, msg, m),
      error: (msg: string, m?: unknown) => log.error(`plugin:${pluginName}`, msg, m),
    }

    const api: OpenClawPluginApi = {
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
            description: def.description || `Plugin tool: ${def.name}`,
            parameters: (def.parameters || { type: 'object', properties: {} }) as Record<string, unknown>,
            planning: isRecord((def as Record<string, unknown>).planning)
              ? (def as PluginToolDef).planning
              : undefined,
            execute: def.execute as PluginToolDef['execute'],
          })
        }
      },
      registerCommand: () => { /* Commands stored as tools */ },
      registerService: () => { /* Services not yet supported in SwarmClaw */ },
      registerProvider: () => { /* Providers not yet bridged */ },
      registerChannel: () => { /* Channels not yet bridged */ },
      registerGatewayMethod: () => { /* RPC not supported */ },
      registerCli: () => { /* CLI not supported */ },
      logger: pluginLogger,
      log: pluginLogger,
      config: {},
      runtime: {},
    }

    try {
      registerFn(api)
    } catch (err: unknown) {
      log.error('plugins', 'OpenClaw register() failed', {
        pluginName,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    return {
      name: pluginName,
      version: pluginVersion,
      description: pluginDesc || `OpenClaw plugin (v${pluginVersion})`,
      author: typeof raw.author === 'string' ? raw.author : undefined,
      openclaw: true,
      hooks,
      tools,
    }
  }

  // --- Legacy OpenClaw format: activate(ctx)/deactivate() ---
  if (raw.name && typeof raw.activate === 'function') {
    const oc = raw as unknown as OpenClawLegacyPlugin
    const hooks: PluginHooks = {}
    const tools: PluginToolDef[] = []

    const registrar = {
      onAgentStart: (fn: (...args: unknown[]) => unknown) => { hooks.beforeAgentStart = fn as PluginHooks['beforeAgentStart'] },
      onAgentComplete: (fn: (...args: unknown[]) => unknown) => { hooks.afterAgentComplete = fn as PluginHooks['afterAgentComplete'] },
      onToolCall: (fn: (...args: unknown[]) => unknown) => { hooks.beforeToolExec = fn as PluginHooks['beforeToolExec'] },
      onToolResult: (fn: (...args: unknown[]) => unknown) => { hooks.afterToolExec = fn as PluginHooks['afterToolExec'] },
      onMessage: (fn: (...args: unknown[]) => unknown) => { hooks.onMessage = fn as PluginHooks['onMessage'] },
      registerTool: (def: PluginToolDef) => { if (def?.name) tools.push(def) },
      log: {
        info: (msg: string, m?: unknown) => log.info(`plugin:${oc.name}`, msg, m),
        warn: (msg: string, m?: unknown) => log.warn(`plugin:${oc.name}`, msg, m),
        error: (msg: string, m?: unknown) => log.error(`plugin:${oc.name}`, msg, m),
      }
    }

    try {
      oc.activate(registrar)
    } catch (err: unknown) {
      log.error('plugins', 'OpenClaw activate() failed', {
        pluginName: oc.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    return {
      name: oc.name,
      version: oc.version,
      description: `OpenClaw plugin (v${oc.version || '0.0.0'})`,
      openclaw: true,
      hooks,
      tools,
    }
  }
  return null
}

interface LoadedPlugin {
  id: string
  meta: PluginMeta
  hooks: PluginHooks
  tools: PluginToolDef[]
  ui?: PluginUIExtension
  providers?: PluginProviderExtension[]
  connectors?: PluginConnectorExtension[]
  isBuiltin?: boolean
}

export interface ExternalPluginToolEntry {
  pluginId: string
  pluginName: string
  tool: PluginToolDef
}

class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map()
  private builtins: Map<string, Plugin> = new Map()
  private loaded = false
  private watcher: fs.FSWatcher | null = null

  registerBuiltin(id: string, plugin: Plugin) {
    const canonicalId = this.canonicalPluginId(id)
    this.builtins.set(canonicalId, plugin)
    // Builtins can be imported/registered after first load, so force re-evaluation.
    this.loaded = false
  }

  private ensurePluginWatcher(): void {
    if (this.watcher) return
    try {
      this.ensurePluginDirs()
      const watcher = fs.watch(PLUGINS_DIR, (_eventType, filename) => {
        if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.mjs'))) return
        this.loaded = false
        notify('plugins')
      })
      watcher.on('error', (err: unknown) => {
        log.warn('plugins', 'Plugin watcher disabled after runtime watch failure', {
          error: err instanceof Error ? err.message : String(err),
        })
        if (this.watcher === watcher) {
          try { watcher.close() } catch { /* ignore */ }
          this.watcher = null
        }
      })
      watcher.unref?.()
      this.watcher = watcher
    } catch (err: unknown) {
      log.warn('plugins', 'Failed to watch plugins directory', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private isExternalPluginFilename(id: string): boolean {
    return id.endsWith('.js') || id.endsWith('.mjs')
  }

  private ensurePluginDirs(): void {
    if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true })
    if (!fs.existsSync(PLUGIN_WORKSPACES_DIR)) fs.mkdirSync(PLUGIN_WORKSPACES_DIR, { recursive: true })
  }

  private getWorkspaceDir(filename: string): string {
    return path.join(PLUGIN_WORKSPACES_DIR, pluginWorkspaceKey(filename))
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

  private getDependencyInfo(filename: string, explicitConfig?: PluginConfigEntry | null): PluginDependencyInfo {
    const manifest = this.readWorkspaceManifest(filename)
    const counts = countManifestDependencies(manifest)
    return {
      hasManifest: !!manifest,
      dependencyCount: counts.dependencyCount,
      devDependencyCount: counts.devDependencyCount,
      packageManager:
        normalizePluginPackageManager(explicitConfig?.packageManager)
        || normalizePluginPackageManager(manifest?.packageManager)
        || undefined,
      installStatus: explicitConfig?.dependencyInstallStatus || (manifest ? 'ready' : 'none'),
      installError: explicitConfig?.dependencyInstallError,
      installedAt: explicitConfig?.dependencyInstalledAt,
    }
  }

  private writeWorkspaceShim(filename: string): void {
    const relEntry = `./.workspaces/${pluginWorkspaceKey(filename)}/index.js`
    const shim = `// Auto-generated plugin workspace shim. Edit the managed source file instead.\nmodule.exports = require(${JSON.stringify(relEntry)})\n`
    fs.writeFileSync(path.join(PLUGINS_DIR, filename), shim, 'utf8')
  }

  private clearPluginRequireCache(dynamicRequire: NodeRequire, filename: string): void {
    const rootPath = path.join(PLUGINS_DIR, filename)
    delete dynamicRequire.cache[rootPath]
    const workspaceDir = this.getWorkspaceDir(filename)
    for (const cacheKey of Object.keys(dynamicRequire.cache)) {
      if (cacheKey.startsWith(`${workspaceDir}${path.sep}`)) {
        delete dynamicRequire.cache[cacheKey]
      }
    }
  }

  private resolvePluginSourcePath(filename: string): string {
    return this.hasWorkspace(filename)
      ? this.getWorkspaceEntryPath(filename)
      : path.join(PLUGINS_DIR, filename)
  }

  private async runDependencyInstall(packageManager: PluginPackageManager, cwd: string): Promise<void> {
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
        reject(new Error(`${command} install timed out after ${Math.round(PACKAGE_INSTALL_TIMEOUT_MS / 1000)}s`))
      }, PACKAGE_INSTALL_TIMEOUT_MS)

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

  private canonicalPluginId(id: string): string {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (!trimmed) return ''
    if (this.isExternalPluginFilename(trimmed)) return path.basename(trimmed)
    return canonicalizePluginId(trimmed)
  }

  private configIdsFor(id: string): string[] {
    const canonicalId = this.canonicalPluginId(id)
    if (!canonicalId) return []
    if (this.isExternalPluginFilename(canonicalId)) return [canonicalId]
    const aliases = getPluginAliases(canonicalId)
    const ids = new Set<string>([canonicalId, ...aliases])
    return Array.from(ids)
  }

  private readConfigEntry(id: string, config?: Record<string, PluginConfigEntry>): PluginConfigEntry | null {
    const cfg = config || this.loadConfig()
    let merged: PluginConfigEntry | null = null
    for (const key of this.configIdsFor(id)) {
      const entry = cfg[key]
      if (!entry) continue
      merged = { ...(merged || {}), ...entry }
      if (key === this.canonicalPluginId(id)) break
    }
    return merged
  }

  private writeConfig(config: Record<string, PluginConfigEntry>): void {
    fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2))
  }

  private updateConfigEntry(id: string, patch: PluginConfigEntry | null): void {
    const canonicalId = this.canonicalPluginId(id)
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
    return new Set(expandPluginIds(enabledIds))
  }

  private readFailureState(): Record<string, PluginFailureRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(PLUGIN_FAILURES, 'utf8')) as Record<string, PluginFailureRecord>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed
    } catch {
      return {}
    }
  }

  private writeFailureState(state: Record<string, PluginFailureRecord>): void {
    try {
      fs.writeFileSync(PLUGIN_FAILURES, JSON.stringify(state, null, 2))
    } catch (err: unknown) {
      log.warn('plugins', 'Failed to persist plugin failure state', { error: err instanceof Error ? err.message : String(err) })
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

  private autoDisableExternalPlugin(id: string, reason: string, failure: PluginFailureRecord): void {
    try {
      const current = this.readConfigEntry(id)
      if (current?.enabled === false) return
      this.updateConfigEntry(id, { ...(current || {}), enabled: false })
    } catch (err: unknown) {
      log.error('plugins', 'Failed to write plugins config while auto-disabling plugin', {
        pluginId: id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    this.loaded = false

    log.error('plugins', 'Auto-disabled plugin after repeated failures', {
      pluginId: id,
      failureCount: failure.count,
      threshold: MAX_CONSECUTIVE_PLUGIN_FAILURES,
      reason,
      lastError: failure.lastError,
      stage: failure.lastStage,
    })

    createNotification({
      type: 'warning',
      title: `Plugin auto-disabled: ${id}`,
      message: `${reason}. It failed ${failure.count} times consecutively and was disabled for stability.`,
      actionLabel: 'Open Plugins',
      actionUrl: '/plugins',
      entityType: 'plugin',
      entityId: id,
      dedupKey: `plugin-auto-disabled:${id}`,
    })
    notify('plugins')
  }

  private markPluginFailure(id: string, stage: string, err: unknown, disableEligible: boolean): void {
    const errorText = err instanceof Error ? err.message : String(err)
    const state = this.readFailureState()
    const failureKey = this.canonicalPluginId(id)
    const nextCount = (state[failureKey]?.count || 0) + 1
    const record: PluginFailureRecord = {
      count: nextCount,
      lastError: errorText,
      lastStage: stage,
      lastFailedAt: Date.now(),
    }
    state[failureKey] = record
    this.writeFailureState(state)

    log.warn('plugins', 'Plugin failure recorded', {
      pluginId: id,
      stage,
      failureCount: nextCount,
      threshold: MAX_CONSECUTIVE_PLUGIN_FAILURES,
      error: errorText,
    })

    if (
      disableEligible
      && nextCount >= MAX_CONSECUTIVE_PLUGIN_FAILURES
      && !this.builtins.has(failureKey)
    ) {
      this.autoDisableExternalPlugin(failureKey, `Plugin failure at ${stage}`, record)
    }
  }

  private markPluginSuccess(id: string): void {
    try {
      this.clearFailureState(id)
    } catch (err: unknown) {
      log.warn('plugins', 'markPluginSuccess failed', { error: err instanceof Error ? err.message : String(err), pluginId: id })
    }
  }

  load() {
    if (this.loaded) return
    this.plugins.clear()
    this.ensurePluginWatcher()

    const config = this.loadConfig()

    // 1. Load Built-ins
    for (const [id, p] of this.builtins.entries()) {
      const explicitConfig = this.readConfigEntry(id, config)
      const isEnabled = explicitConfig != null ? explicitConfig.enabled !== false : p.enabledByDefault !== false
      if (isEnabled) {
        this.plugins.set(id, {
          id,
          meta: {
            name: p.name,
            description: p.description || '',
            filename: id,
            enabled: true,
            author: p.author || 'SwarmClaw',
            version: p.version || '1.0.0',
            source: 'local',
            openclaw: p.openclaw === true,
          },
          hooks: p.hooks || {},
          tools: p.tools || [],
          ui: p.ui,
          providers: p.providers,
          connectors: p.connectors,
          isBuiltin: true
        })
        this.markPluginSuccess(id)
      }
    }

    // 2. Load External
    try {
      this.ensurePluginDirs()
      const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
      
      let dynamicRequire: NodeRequire | null = null
      try {
        dynamicRequire = createRequire(import.meta.url || __filename)
      } catch (err: unknown) {
        log.warn('plugins', 'createRequire failed; external plugins disabled', {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      if (dynamicRequire) {
        for (const file of files) {
          try {
            const explicitConfig = this.readConfigEntry(file, config)
            const isEnabled = explicitConfig?.enabled !== false
            if (!isEnabled) continue

            const fullPath = path.join(PLUGINS_DIR, file)
            this.clearPluginRequireCache(dynamicRequire, file)
            const plugin = normalizePlugin(dynamicRequire(fullPath))
            if (!plugin) {
              this.markPluginFailure(file, 'load.normalize', 'Plugin format unsupported or activate() failed', true)
              continue
            }

            this.plugins.set(file, {
              id: file,
              meta: {
                name: plugin.name,
                description: plugin.description || '',
                filename: file,
                enabled: true,
                author: plugin.author,
                version: plugin.version || '0.0.1',
                source: explicitConfig?.sourceUrl ? 'marketplace' : 'local',
                openclaw: plugin.openclaw === true,
              },
              hooks: plugin.hooks || {},
              tools: plugin.tools || [],
              ui: plugin.ui,
              providers: plugin.providers,
              connectors: plugin.connectors,
            })
            this.markPluginSuccess(file)
          } catch (err: unknown) {
            log.error('plugins', 'Failed to load external plugin', {
              pluginId: file,
              error: err instanceof Error ? err.message : String(err),
            })
            this.markPluginFailure(file, 'load.require', err, true)
          }
        }
      }
    } catch { /* ignore */ }

    this.loaded = true
  }

  getTools(enabledIds: string[]): Array<{ pluginId: string; tool: PluginToolDef }> {
    this.load()
    const all: Array<{ pluginId: string; tool: PluginToolDef }> = []
    const ids = new Set(expandPluginIds(enabledIds))
    for (const [id, p] of this.plugins.entries()) {
      if (ids.has(id)) {
        const tools = Array.isArray(p.tools) ? p.tools : []
        for (const t of tools) {
          if (!t || typeof t.name !== 'string' || typeof t.execute !== 'function') continue
          all.push({ pluginId: id, tool: t })
        }
      }
    }
    return all
  }

  getExternalTools(): PluginToolDef[] {
    return this.getExternalToolEntries().map((entry) => entry.tool)
  }

  getExternalToolEntries(): ExternalPluginToolEntry[] {
    this.load()
    const all: ExternalPluginToolEntry[] = []
    for (const p of this.plugins.values()) {
      if (p.isBuiltin) continue
      const pluginTools = Array.isArray(p.tools) ? p.tools : []
      for (const tool of pluginTools) {
        if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') continue
        all.push({
          pluginId: p.id,
          pluginName: p.meta.name,
          tool,
        })
      }
    }
    return all
  }

  getProviders(): PluginProviderExtension[] {
    this.load()
    const allProviders: PluginProviderExtension[] = []
    for (const p of this.plugins.values()) {
      if (p.providers) allProviders.push(...p.providers)
    }
    return allProviders
  }

  getConnectors(): PluginConnectorExtension[] {
    this.load()
    const allConnectors: PluginConnectorExtension[] = []
    for (const p of this.plugins.values()) {
      if (p.connectors) allConnectors.push(...p.connectors)
    }
    return allConnectors
  }

  getUIExtensions(): PluginUIExtension[] {
    this.load()
    const allUI: PluginUIExtension[] = []
    for (const p of this.plugins.values()) {
      if (p.ui) allUI.push(p.ui)
    }
    return allUI
  }

  listPluginIds(): string[] {
    this.load()
    return Array.from(this.plugins.keys())
  }

  async runHook<K extends keyof PluginHooks>(hookName: K, ctx: HookContext<K>, options?: HookExecutionOptions) {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)

    for (const [id, p] of this.plugins.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          await (hook as (hookCtx: HookContext<K>) => Promise<unknown> | unknown)(ctx)
          this.markPluginSuccess(id)
        } catch (err: unknown) {
          log.error('plugins', 'Plugin hook failed', {
            pluginId: id,
            pluginName: p.meta.name,
            hookName: String(hookName),
            error: err instanceof Error ? err.message : String(err),
          })
          this.markPluginFailure(id, `hook.${String(hookName)}`, err, true)
        }
      }
    }
  }

  async runBeforeToolExec(
    params: { toolName: string; input: Record<string, unknown> | null },
    options?: HookExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentInput = params.input

    for (const [id, p] of this.plugins.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks.beforeToolExec
      if (!hook) continue
      try {
        const result = await hook({ toolName: params.toolName, input: currentInput })
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          currentInput = result as Record<string, unknown>
        }
        this.markPluginSuccess(id)
      } catch (err: unknown) {
        log.error('plugins', 'beforeToolExec hook failed', {
          pluginId: id,
          pluginName: p.meta.name,
          toolName: params.toolName,
          error: err instanceof Error ? err.message : String(err),
        })
        this.markPluginFailure(id, 'hook.beforeToolExec', err, true)
      }
    }

    return currentInput
  }

  async transformText(
    hookName: 'transformInboundMessage' | 'transformOutboundMessage',
    params: { session: Session; text: string },
    options?: HookExecutionOptions,
  ): Promise<string> {
    this.load()
    const filterIds = this.resolveEnabledFilter(options?.enabledIds, options?.includeAllWhenEmpty === true)
    let currentText = params.text

    for (const [id, p] of this.plugins.entries()) {
      if (filterIds !== null && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          const result = await (hook as (ctx: typeof params) => Promise<string> | string)({ ...params, text: currentText })
          if (typeof result === 'string') currentText = result
          this.markPluginSuccess(id)
        } catch (err: unknown) {
          log.error('plugins', 'Plugin transform hook failed', {
            pluginId: id,
            pluginName: p.meta.name,
            hookName,
            error: err instanceof Error ? err.message : String(err),
          })
          this.markPluginFailure(id, `hook.${String(hookName)}`, err, true)
        }
      }
    }
    return currentText
  }

  async collectAgentContext(session: import('@/types').Session, enabledPlugins: string[], message: string, history: import('@/types').Message[]): Promise<string[]> {
    this.load()
    const enabledSet = new Set(expandPluginIds(enabledPlugins))
    const parts: string[] = []

    for (const [id, p] of this.plugins.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getAgentContext
      if (!hook) continue
      try {
        const result = await hook({ session, enabledPlugins, message, history })
        if (typeof result === 'string' && result.trim()) {
          parts.push(result)
          this.markPluginSuccess(id)
        }
      } catch (err: unknown) {
        log.error('plugins', 'getAgentContext hook failed', {
          pluginId: id,
          pluginName: p.meta.name,
          error: err instanceof Error ? err.message : String(err),
        })
        this.markPluginFailure(id, 'hook.getAgentContext', err, true)
      }
    }

    return parts
  }

  /** Collect capability descriptions from all enabled plugins for system prompt */
  collectCapabilityDescriptions(enabledPlugins: string[]): string[] {
    this.load()
    const enabledSet = new Set(expandPluginIds(enabledPlugins))
    const lines: string[] = []

    for (const [id, p] of this.plugins.entries()) {
      if (!enabledSet.has(id)) continue
      const hook = p.hooks.getCapabilityDescription
      if (!hook) continue
      try {
        const result = hook()
        if (typeof result === 'string' && result.trim()) {
          lines.push(`- ${result}`)
        }
      } catch (err: unknown) {
        log.error('plugins', 'getCapabilityDescription hook failed', { pluginId: id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return lines
  }

  /** Collect operating guidance from all enabled plugins */
  collectOperatingGuidance(enabledPlugins: string[]): string[] {
    this.load()
    const enabledSet = new Set(expandPluginIds(enabledPlugins))
    const lines: string[] = []

    for (const [id, p] of this.plugins.entries()) {
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
        log.error('plugins', 'getOperatingGuidance hook failed', { pluginId: id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return lines
  }

  /** Collect all settings fields declared by enabled plugins */
  collectSettingsFields(enabledPlugins: string[]): Array<{ pluginId: string; pluginName: string; fields: import('@/types').PluginSettingsField[] }> {
    this.load()
    const enabledSet = new Set(expandPluginIds(enabledPlugins))
    const result: Array<{ pluginId: string; pluginName: string; fields: import('@/types').PluginSettingsField[] }> = []

    for (const [id, p] of this.plugins.entries()) {
      if (!enabledSet.has(id)) continue
      const fields = p.ui?.settingsFields
      if (fields?.length) {
        result.push({ pluginId: id, pluginName: p.meta.name, fields })
      }
    }

    return result
  }

  getSettingsFields(pluginId: string): import('@/types').PluginSettingsField[] {
    this.load()
    const candidateIds = expandPluginIds([pluginId])
    for (const id of candidateIds) {
      const plugin = this.plugins.get(id) || (this.builtins.has(id) ? {
        ui: this.builtins.get(id)?.ui,
      } as LoadedPlugin : null)
      const fields = plugin?.ui?.settingsFields
      if (fields?.length) return fields
    }
    return []
  }

  getPluginSettings(pluginId: string): Record<string, unknown> {
    const settings = loadSettings()
    const allSettings = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    const result: Record<string, unknown> = {}

    for (const key of this.configIdsFor(pluginId)) {
      const values = allSettings[key]
      if (!values || typeof values !== 'object') continue
      for (const [fieldKey, fieldValue] of Object.entries(values)) {
        if (isPluginSecretSettingValue(fieldValue)) {
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

    for (const field of this.getSettingsFields(pluginId)) {
      if (result[field.key] === undefined && field.defaultValue !== undefined) {
        result[field.key] = field.defaultValue
      }
    }

    return result
  }

  getPublicPluginSettings(pluginId: string): { values: Record<string, unknown>; configuredSecretFields: string[] } {
    const values = this.getPluginSettings(pluginId)
    const configuredSecretFields: string[] = []

    for (const field of this.getSettingsFields(pluginId)) {
      if (field.type !== 'secret') continue
      const current = values[field.key]
      if (typeof current === 'string' && current.trim()) {
        configuredSecretFields.push(field.key)
      }
      values[field.key] = ''
    }

    return { values, configuredSecretFields }
  }

  setPluginSettings(pluginId: string, values: Record<string, unknown>): Record<string, unknown> {
    const fields = this.getSettingsFields(pluginId)
    if (fields.length === 0 && Object.keys(values || {}).length > 0) {
      throw new Error(`Plugin "${pluginId}" does not declare configurable settings`)
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
    const pluginSettings = (currentSettings.pluginSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    const canonicalId = this.canonicalPluginId(pluginId)
    const existingStored: Record<string, unknown> = {}
    for (const alias of this.configIdsFor(canonicalId)) {
      const existing = pluginSettings[alias]
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
          __pluginSecret: true,
          encrypted: encryptKey(String(nextValues[field.key] ?? '')),
        } satisfies PluginSecretSettingValue
      } else {
        stored[field.key] = nextValues[field.key]
      }
    }

    for (const alias of this.configIdsFor(canonicalId)) {
      delete pluginSettings[alias]
    }
    pluginSettings[canonicalId] = stored
    currentSettings.pluginSettings = pluginSettings
    saveSettings(currentSettings)

    return this.getPublicPluginSettings(canonicalId).values
  }

  recordExternalToolFailure(pluginId: string, toolName: string, err: unknown): void {
    this.markPluginFailure(pluginId, `tool.${toolName}`, err, true)
  }

  recordExternalToolSuccess(pluginId: string): void {
    this.markPluginSuccess(pluginId)
  }

  isEnabled(filename: string): boolean {
    const explicit = this.readConfigEntry(filename)
    if (explicit != null) return explicit.enabled !== false
    const builtin = this.builtins.get(this.canonicalPluginId(filename))
    if (builtin) return builtin.enabledByDefault !== false
    return true
  }

  listPlugins(): PluginMeta[] {
    try {
      this.load()
      const config = this.loadConfig()
      const failures = this.readFailureState()
      const metas: PluginMeta[] = []

      const describeCapabilities = (loaded?: LoadedPlugin, fallback?: Plugin): Pick<PluginMeta, 'toolCount' | 'hookCount' | 'hasUI' | 'providerCount' | 'connectorCount' | 'settingsFields'> => {
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
        const loaded = this.plugins.get(id)
        const explicitCfg = this.readConfigEntry(id, config)
        const enabled = explicitCfg != null ? explicitCfg.enabled !== false : p.enabledByDefault !== false
        const failure = failures[this.canonicalPluginId(id)]
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
          openclaw: p.openclaw === true,
          failureCount: failure?.count,
          lastFailureAt: failure?.lastFailedAt,
          lastFailureStage: failure?.lastStage,
          lastFailureError: failure?.lastError,
          autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_PLUGIN_FAILURES,
          ...caps,
        })
      }

      // Add external files
      try {
        const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
        for (const f of files) {
          if (!metas.find(m => m.filename === f)) {
            const loaded = this.plugins.get(f)
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
              source: loaded?.meta.source || (explicitCfg?.sourceUrl ? 'marketplace' : 'local'),
              openclaw: loaded?.meta.openclaw,
              createdByAgentId: explicitCfg?.createdByAgentId || null,
              failureCount: failure?.count,
              lastFailureAt: failure?.lastFailedAt,
              lastFailureStage: failure?.lastStage,
              lastFailureError: failure?.lastError,
              autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_PLUGIN_FAILURES,
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
      log.error('plugins', 'listPlugins failed', { error: err instanceof Error ? err.message : String(err) })
      return []
    }
  }

  readPluginSource(filename: string): string {
    const fullPath = this.resolvePluginSourcePath(filename)
    if (!fs.existsSync(fullPath)) throw new Error(`Plugin not found: ${filename}`)
    return fs.readFileSync(fullPath, 'utf8')
  }

  async savePluginSource(filename: string, code: string, options?: UpsertPluginOptions): Promise<void> {
    const sanitizedFilename = sanitizePluginFilename(filename)
    this.ensurePluginDirs()

    const shouldUseWorkspace = this.hasWorkspace(sanitizedFilename) || options?.packageJson !== undefined
    const sourcePath = shouldUseWorkspace
      ? this.getWorkspaceEntryPath(sanitizedFilename)
      : path.join(PLUGINS_DIR, sanitizedFilename)

    if (shouldUseWorkspace) {
      fs.mkdirSync(this.getWorkspaceDir(sanitizedFilename), { recursive: true })
      fs.writeFileSync(sourcePath, code, 'utf8')
      this.writeWorkspaceShim(sanitizedFilename)
    } else {
      fs.writeFileSync(sourcePath, code, 'utf8')
    }

    const normalizedPackageManager = normalizePluginPackageManager(options?.packageManager)

    if (options?.packageJson !== undefined) {
      if (!shouldUseWorkspace) {
        throw new Error('Plugin workspace is required for package.json support')
      }
      const manifest = normalizePluginManifest(options.packageJson, sanitizedFilename, normalizedPackageManager)
      fs.writeFileSync(this.getWorkspaceManifestPath(sanitizedFilename), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      this.setMeta(sanitizedFilename, {
        ...(options?.meta || {}),
        packageManager: normalizedPackageManager || normalizePluginPackageManager(manifest.packageManager) || undefined,
        dependencyInstallStatus: 'ready',
        dependencyInstallError: undefined,
        dependencyInstalledAt: undefined,
      })
    } else if (options?.meta && Object.keys(options.meta).length > 0) {
      this.setMeta(sanitizedFilename, options.meta)
    }

    if (options?.installDependencies) {
      await this.installPluginDependencies(sanitizedFilename, {
        packageManager: normalizedPackageManager || undefined,
      })
    }

    this.reload()
  }

  async installPluginDependencies(filename: string, options?: { packageManager?: PluginPackageManager }): Promise<PluginDependencyInfo> {
    const sanitizedFilename = sanitizePluginFilename(filename)
    const fullPath = path.join(PLUGINS_DIR, sanitizedFilename)
    if (!fs.existsSync(fullPath) && !this.hasWorkspace(sanitizedFilename)) {
      throw new Error(`Plugin not found: ${sanitizedFilename}`)
    }

    this.ensurePluginDirs()
    const workspaceDir = this.getWorkspaceDir(sanitizedFilename)
    const sourcePath = this.resolvePluginSourcePath(sanitizedFilename)
    const currentCode = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : ''

    if (!this.hasWorkspace(sanitizedFilename)) {
      fs.mkdirSync(workspaceDir, { recursive: true })
      fs.writeFileSync(this.getWorkspaceEntryPath(sanitizedFilename), currentCode, 'utf8')
      this.writeWorkspaceShim(sanitizedFilename)
    }

    const manifest = this.readWorkspaceManifest(sanitizedFilename)
    if (!manifest) throw new Error(`Plugin "${sanitizedFilename}" does not have a package.json manifest`)

    const packageManager = options?.packageManager
      || normalizePluginPackageManager(this.readConfigEntry(sanitizedFilename)?.packageManager)
      || normalizePluginPackageManager(manifest.packageManager)
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
      const message = err instanceof Error ? err.message : String(err)
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

  deletePlugin(filename: string): boolean {
    // Only allow deleting external plugins, not builtins
    if (this.builtins.has(this.canonicalPluginId(filename))) return false
    const fullPath = path.join(PLUGINS_DIR, filename)
    if (!fs.existsSync(fullPath)) return false
    fs.unlinkSync(fullPath)
    const workspaceDir = this.getWorkspaceDir(filename)
    if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true })
    this.updateConfigEntry(filename, null)
    const settings = loadSettings()
    const pluginSettings = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
    for (const key of this.configIdsFor(filename)) delete pluginSettings[key]
    settings.pluginSettings = pluginSettings
    saveSettings(settings)
    this.clearFailureState(filename)
    this.reload()
    return true
  }

  async installPluginFromUrl(url: string, filename: string, meta?: Record<string, unknown>): Promise<InstalledPluginSource> {
    const sanitizedFilename = sanitizePluginFilename(filename)
    const download = await downloadPluginSource(url)
    await this.savePluginSource(sanitizedFilename, download.code, {
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

  async updatePlugin(id: string) {
    this.load()
    const p = this.plugins.get(id)
    if (!p) throw new Error('Plugin not found')
    if (p.isBuiltin) throw new Error('Built-in plugins are updated via application releases')

    log.info('plugins', 'Updating plugin', { pluginId: id, pluginName: p.meta.name })
    const current = this.readConfigEntry(id)
    const sourceUrl = current?.sourceUrl?.trim()
    if (!sourceUrl) throw new Error(`Plugin "${id}" has no recorded source URL and cannot be updated automatically`)

    const download = await downloadPluginSource(sourceUrl)
    const fullPath = path.join(PLUGINS_DIR, id)
    fs.writeFileSync(fullPath, download.code, 'utf8')
    this.setMeta(id, {
      sourceUrl: download.normalizedUrl,
      sourceHash: download.hash,
      updatedAt: Date.now(),
    })

    this.reload()
    return true
  }

  async updateAllPlugins() {
    this.load()
    const ids = Array.from(this.plugins.entries())
      .filter(([, plugin]) => !plugin.isBuiltin)
      .map(([id]) => id)
    for (const id of ids) {
      try {
        await this.updatePlugin(id)
      } catch { /* ignore individual failures */ }
    }
    return true
  }

  setMeta(filename: string, meta: Record<string, unknown>) {
    const current = this.readConfigEntry(filename)
    this.updateConfigEntry(filename, { ...(current || {}), ...(meta as PluginConfigEntry) })
  }

  private loadConfig(): Record<string, PluginConfigEntry> {
    try { return JSON.parse(fs.readFileSync(PLUGINS_CONFIG, 'utf8')) } catch { return {} }
  }

  reload() { this.loaded = false; this.load() }
}

let _manager: PluginManager | null = null
export function getPluginManager(): PluginManager {
  try {
    if (!_manager) {
      _manager = new PluginManager()
    }
    return _manager
  } catch (err: unknown) {
    log.error('plugins', 'getPluginManager critical failure', { error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}
