import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import type { Plugin, PluginHooks, PluginMeta, PluginToolDef, PluginUIExtension, PluginProviderExtension, PluginConnectorExtension, Session } from '@/types'
import { DATA_DIR } from './data-dir'
import { expandPluginIds } from './tool-aliases'
import { log } from './logger'
import { createNotification } from './create-notification'
import { notify } from './ws-hub'

const PLUGINS_DIR = path.join(DATA_DIR, 'plugins')
const PLUGINS_CONFIG = path.join(DATA_DIR, 'plugins.json')
const PLUGIN_FAILURES = path.join(DATA_DIR, 'plugin-failures.json')
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
  registerTool: (def: PluginToolDef | { name: string; description?: string; parameters?: Record<string, unknown>; execute: (...args: unknown[]) => unknown }) => void
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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

  registerBuiltin(id: string, plugin: Plugin) {
    this.builtins.set(id, plugin)
    // Builtins can be imported/registered after first load, so force re-evaluation.
    this.loaded = false
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
    if (!state[id]) return
    delete state[id]
    this.writeFailureState(state)
  }

  private autoDisableExternalPlugin(id: string, reason: string, failure: PluginFailureRecord): void {
    const config = this.loadConfig()
    if (config[id]?.enabled === false) return
    config[id] = { ...config[id], enabled: false }
    try {
      fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2))
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
    const nextCount = (state[id]?.count || 0) + 1
    const record: PluginFailureRecord = {
      count: nextCount,
      lastError: errorText,
      lastStage: stage,
      lastFailedAt: Date.now(),
    }
    state[id] = record
    this.writeFailureState(state)

    log.warn('plugins', 'Plugin failure recorded', {
      pluginId: id,
      stage,
      failureCount: nextCount,
      threshold: MAX_CONSECUTIVE_PLUGIN_FAILURES,
      error: errorText,
    })

    if (disableEligible && nextCount >= MAX_CONSECUTIVE_PLUGIN_FAILURES) {
      this.autoDisableExternalPlugin(id, `Plugin failure at ${stage}`, record)
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

    const config = this.loadConfig()

    // 1. Load Built-ins
    for (const [id, p] of this.builtins.entries()) {
      const explicitConfig = config[id]
      const isEnabled = explicitConfig != null ? explicitConfig.enabled !== false : p.enabledByDefault !== false
      if (isEnabled) {
        this.plugins.set(id, {
          id,
          meta: { name: p.name, description: p.description || '', filename: id, enabled: true },
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
      if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true })
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
            const isEnabled = config[file]?.enabled !== false
            if (!isEnabled) continue

            const fullPath = path.join(PLUGINS_DIR, file)
            delete dynamicRequire.cache[fullPath]
            const plugin = normalizePlugin(dynamicRequire(fullPath))
            if (!plugin) {
              this.markPluginFailure(file, 'load.normalize', 'Plugin format unsupported or activate() failed', true)
              continue
            }

            this.plugins.set(file, {
              id: file,
              meta: { name: plugin.name, description: plugin.description || '', filename: file, enabled: true },
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
    const ids = new Set(enabledIds)
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

  async runHook<K extends keyof PluginHooks>(hookName: K, ctx: HookContext<K>, enabledIds: string[] = []) {
    this.load()
    // If no enabledIds provided, run for all loaded plugins (legacy behavior)
    const filterIds = enabledIds.length > 0 ? new Set(enabledIds) : null

    for (const [id, p] of this.plugins.entries()) {
      if (filterIds && !filterIds.has(id)) continue
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

  async transformText(
    hookName: 'transformInboundMessage' | 'transformOutboundMessage',
    params: { session: Session; text: string },
    enabledIds: string[] = [],
  ): Promise<string> {
    this.load()
    const filterIds = enabledIds.length > 0 ? new Set(enabledIds) : null
    let currentText = params.text

    for (const [id, p] of this.plugins.entries()) {
      if (filterIds && !filterIds.has(id)) continue
      const hook = p.hooks[hookName]
      if (hook) {
        try {
          const result = await (hook as (ctx: typeof params) => Promise<string> | string)(params)
          currentText = result
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
    const enabledSet = new Set(enabledPlugins)
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

  recordExternalToolFailure(pluginId: string, toolName: string, err: unknown): void {
    this.markPluginFailure(pluginId, `tool.${toolName}`, err, true)
  }

  recordExternalToolSuccess(pluginId: string): void {
    this.markPluginSuccess(pluginId)
  }

  isEnabled(filename: string): boolean {
    const config = this.loadConfig()
    const explicit = config[filename]
    if (explicit != null) return explicit.enabled !== false
    const builtin = this.builtins.get(filename)
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
        const explicitCfg = config[id]
        const enabled = explicitCfg != null ? explicitCfg.enabled !== false : p.enabledByDefault !== false
        const failure = failures[id]
        const caps = describeCapabilities(loaded, p)
        metas.push({
          name: p.name,
          description: p.description || '',
          filename: id,
          enabled,
          author: 'SwarmClaw',
          version: (p as { version?: string }).version || loaded?.meta.version || '1.0.0',
          source: loaded?.meta.source || 'local',
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
            const enabled = config[f]?.enabled !== false
            const failure = failures[f]
            const caps = describeCapabilities(loaded)
            metas.push({
              name: loaded?.meta.name || f.replace(/\.(js|mjs)$/, ''),
              filename: f,
              enabled,
              author: loaded?.meta.author,
              version: loaded?.meta.version || '0.0.1',
              source: loaded?.meta.source || 'marketplace',
              createdByAgentId: config[f]?.createdByAgentId || null,
              failureCount: failure?.count,
              lastFailureAt: failure?.lastFailedAt,
              lastFailureStage: failure?.lastStage,
              lastFailureError: failure?.lastError,
              autoDisabled: !enabled && !!failure && failure.count >= MAX_CONSECUTIVE_PLUGIN_FAILURES,
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

  setEnabled(filename: string, enabled: boolean) {
    const config = this.loadConfig()
    config[filename] = { ...config[filename], enabled }
    fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2))
    if (enabled) this.clearFailureState(filename)
    this.reload()
  }

  deletePlugin(filename: string): boolean {
    // Only allow deleting external plugins, not builtins
    if (this.builtins.has(filename)) return false
    const fullPath = path.join(PLUGINS_DIR, filename)
    if (!fs.existsSync(fullPath)) return false
    fs.unlinkSync(fullPath)
    // Remove from config
    const config = this.loadConfig()
    delete config[filename]
    fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2))
    this.clearFailureState(filename)
    this.reload()
    return true
  }

  async updatePlugin(id: string) {
    this.load()
    const p = this.plugins.get(id)
    if (!p) throw new Error('Plugin not found')

    log.info('plugins', 'Updating plugin', { pluginId: id, pluginName: p.meta.name })
    // If it's from marketplace, we'd refetch from URL.
    // For this demo, we'll just simulate a version bump if it's external.
    if (!p.isBuiltin) {
      const fullPath = path.join(PLUGINS_DIR, id)
      if (fs.existsSync(fullPath)) {
        let content = fs.readFileSync(fullPath, 'utf8')
        // Simulate a version bump in the file content
        const versionMatch = content.match(/version:\s*['"]([^'"]+)['"]/)
        if (versionMatch) {
          const current = versionMatch[1]
          const next = current.split('.').map((v, i) => i === 2 ? parseInt(v) + 1 : v).join('.')
          content = content.replace(`version: '${current}'`, `version: '${next}'`)
          content = content.replace(`version: "${current}"`, `version: "${next}"`)
          fs.writeFileSync(fullPath, content, 'utf8')
        }
      }
    }

    this.reload()
    return true
  }

  async updateAllPlugins() {
    this.load()
    const ids = Array.from(this.plugins.keys())
    for (const id of ids) {
      try {
        await this.updatePlugin(id)
      } catch { /* ignore individual failures */ }
    }
    return true
  }

  setMeta(filename: string, meta: Record<string, unknown>) {
    const config = this.loadConfig()
    config[filename] = { ...config[filename], ...meta }
    fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2))
  }

  private loadConfig(): Record<string, { enabled?: boolean; createdByAgentId?: string }> {
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
