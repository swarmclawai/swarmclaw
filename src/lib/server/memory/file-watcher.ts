import fs from 'fs'
import path from 'path'
import { log } from '@/lib/server/logger'

/**
 * Memory File Watcher
 *
 * Watches workspace directories for file changes that affect memory entries.
 * When referenced files are created, modified, or deleted, queues a callback
 * so the memory system can update stale references.
 */

type ChangeCallback = (changedPath: string, eventType: 'rename' | 'change') => void

const DEBOUNCE_MS = 500
const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /\.next\//,
  /\.swp$/,
  /\.DS_Store$/,
  /~$/,
]

function shouldIgnore(filePath: string): boolean {
  return IGNORED_PATTERNS.some((p) => p.test(filePath))
}

export class MemoryFileWatcher {
  private watchers = new Map<string, fs.FSWatcher>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private callback: ChangeCallback
  private stopped = false

  constructor(callback: ChangeCallback) {
    this.callback = callback
  }

  /**
   * Start watching a directory (non-recursive by default, recursive on supported platforms).
   */
  watch(dirPath: string): void {
    if (this.stopped) return
    if (this.watchers.has(dirPath)) return
    if (!fs.existsSync(dirPath)) return

    try {
      const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        const fullPath = path.join(dirPath, filename)
        if (shouldIgnore(fullPath)) return

        // Debounce rapid changes to the same file
        const existing = this.debounceTimers.get(fullPath)
        if (existing) clearTimeout(existing)

        this.debounceTimers.set(fullPath, setTimeout(() => {
          this.debounceTimers.delete(fullPath)
          try {
            this.callback(fullPath, eventType as 'rename' | 'change')
          } catch (err: unknown) {
            log.error('memory-file-watcher', 'Callback error', {
              path: fullPath,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }, DEBOUNCE_MS))
      })

      watcher.on('error', (err) => {
        log.warn('memory-file-watcher', `Watcher error for ${dirPath}`, { error: err.message })
        this.unwatch(dirPath)
      })

      this.watchers.set(dirPath, watcher)
      log.info('memory-file-watcher', `Watching directory: ${dirPath}`)
    } catch (err: unknown) {
      log.warn('memory-file-watcher', `Failed to watch ${dirPath}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  unwatch(dirPath: string): void {
    const watcher = this.watchers.get(dirPath)
    if (watcher) {
      watcher.close()
      this.watchers.delete(dirPath)
    }
  }

  stop(): void {
    this.stopped = true
    for (const [dir, watcher] of this.watchers) {
      watcher.close()
      this.watchers.delete(dir)
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }

  get watchedDirs(): string[] {
    return Array.from(this.watchers.keys())
  }

  get isActive(): boolean {
    return !this.stopped && this.watchers.size > 0
  }
}

// Singleton watcher instance (HMR-safe via globalThis)
const GLOBAL_KEY = '__swarmclaw_memory_file_watcher__'

export function getMemoryFileWatcher(callback: ChangeCallback): MemoryFileWatcher {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as MemoryFileWatcher | undefined
  if (existing?.isActive) return existing

  const watcher = new MemoryFileWatcher(callback)
  ;(globalThis as Record<string, unknown>)[GLOBAL_KEY] = watcher
  return watcher
}

export function stopMemoryFileWatcher(): void {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as MemoryFileWatcher | undefined
  if (existing) {
    existing.stop()
    delete (globalThis as Record<string, unknown>)[GLOBAL_KEY]
  }
}
