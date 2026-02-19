import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import type { Plugin, PluginHooks, PluginMeta } from '@/types'

const PLUGINS_DIR = path.join(process.cwd(), 'data', 'plugins')
const PLUGINS_CONFIG = path.join(process.cwd(), 'data', 'plugins.json')

// Ensure directories exist
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true })
if (!fs.existsSync(PLUGINS_CONFIG)) fs.writeFileSync(PLUGINS_CONFIG, '{}')

// Use createRequire to avoid Turbopack static analysis of require()
const dynamicRequire = createRequire(import.meta.url || __filename)

interface LoadedPlugin {
  meta: PluginMeta
  hooks: PluginHooks
}

class PluginManager {
  private plugins: LoadedPlugin[] = []
  private loaded = false

  load() {
    if (this.loaded) return
    this.plugins = []

    const config = this.loadConfig()

    try {
      const files = fs.readdirSync(PLUGINS_DIR).filter(
        (f) => f.endsWith('.js') || f.endsWith('.mjs'),
      )

      for (const file of files) {
        try {
          const fullPath = path.join(PLUGINS_DIR, file)
          // Clear require cache to allow reloads
          delete dynamicRequire.cache[fullPath]
          const mod = dynamicRequire(fullPath)
          const plugin: Plugin = mod.default || mod

          if (!plugin.name || !plugin.hooks) {
            console.warn(`[plugins] Skipping ${file}: missing name or hooks`)
            continue
          }

          const isEnabled = config[file]?.enabled !== false // enabled by default

          if (isEnabled) {
            this.plugins.push({
              meta: {
                name: plugin.name,
                description: plugin.description,
                filename: file,
                enabled: true,
              },
              hooks: plugin.hooks,
            })
            console.log(`[plugins] Loaded: ${plugin.name} (${file})`)
          }
        } catch (err: any) {
          console.error(`[plugins] Failed to load ${file}:`, err.message)
        }
      }
    } catch {
      // plugins dir doesn't exist or can't be read
    }

    this.loaded = true
  }

  async runHook<K extends keyof PluginHooks>(
    hookName: K,
    ctx: Parameters<NonNullable<PluginHooks[K]>>[0],
  ): Promise<void> {
    this.load()
    for (const plugin of this.plugins) {
      const hook = plugin.hooks[hookName]
      if (hook) {
        try {
          await (hook as any)(ctx)
        } catch (err: any) {
          console.error(`[plugins] Error in ${plugin.meta.name}.${hookName}:`, err.message)
        }
      }
    }
  }

  listPlugins(): PluginMeta[] {
    this.load()
    const config = this.loadConfig()

    // Include both loaded and disabled plugins
    const metas: PluginMeta[] = this.plugins.map((p) => p.meta)

    try {
      const files = fs.readdirSync(PLUGINS_DIR).filter(
        (f) => f.endsWith('.js') || f.endsWith('.mjs'),
      )
      for (const file of files) {
        if (!metas.find((m) => m.filename === file)) {
          metas.push({
            name: file.replace(/\.(js|mjs)$/, ''),
            filename: file,
            enabled: config[file]?.enabled !== false,
          })
        }
      }
    } catch { /* ignore */ }

    return metas
  }

  setEnabled(filename: string, enabled: boolean) {
    const config = this.loadConfig()
    config[filename] = { ...config[filename], enabled }
    fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2))
    // Force reload on next hook call
    this.loaded = false
    this.plugins = []
  }

  private loadConfig(): Record<string, { enabled: boolean }> {
    try {
      return JSON.parse(fs.readFileSync(PLUGINS_CONFIG, 'utf8'))
    } catch {
      return {}
    }
  }

  reload() {
    this.loaded = false
    this.plugins = []
    this.load()
  }
}

let _manager: PluginManager | null = null

export function getPluginManager(): PluginManager {
  if (!_manager) {
    _manager = new PluginManager()
    _manager.load()
  }
  return _manager
}
