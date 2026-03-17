import { safeJsonParseObject } from './json-utils'
import { hmrSingleton } from '@/lib/shared-utils'
import type { AppSettings } from '@/types'

// --- TTL Cache (read-through with write-through invalidation) ---

interface TTLEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Simple TTL cache for hot-path reads that rarely change.
 * Stored on globalThis so HMR doesn't reset it.
 */
export class TTLCache<T> {
  private entry: TTLEntry<T> | null = null
  constructor(private readonly ttlMs: number) {}

  get(): T | undefined {
    if (!this.entry) return undefined
    if (Date.now() > this.entry.expiresAt) {
      this.entry = null
      return undefined
    }
    return this.entry.value
  }

  set(value: T): void {
    this.entry = { value, expiresAt: Date.now() + this.ttlMs }
  }

  invalidate(): void {
    this.entry = null
  }
}

type TTLCacheStore = {
  settings?: TTLCache<AppSettings>
  agents?: TTLCache<Record<string, unknown>>
  sessions?: TTLCache<Record<string, unknown>>
}
const ttlCaches: TTLCacheStore = hmrSingleton<TTLCacheStore>('__swarmclaw_ttl_caches__', () => ({}))

export function getSettingsCache() { return ttlCaches.settings ?? (ttlCaches.settings = new TTLCache(60_000)) }
export function getAgentsCache() { return ttlCaches.agents ?? (ttlCaches.agents = new TTLCache(15_000)) }
export function getSessionsCache() { return ttlCaches.sessions ?? (ttlCaches.sessions = new TTLCache(5_000)) }

// --- LRU Cache ---

const DEFAULT_LRU_CAPACITY = 5000

/** Per-collection capacity overrides from COLLECTION_CACHE_LIMITS env var (JSON). */
export function parseCacheLimits(): Record<string, number> {
  const raw = process.env.COLLECTION_CACHE_LIMITS
  if (!raw) return {}
  const parsed = safeJsonParseObject(raw)
  if (!parsed) return {}
  const result: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && v > 0) result[k] = v
  }
  return result
}

const cacheLimits = parseCacheLimits()

export function capacityFor(collection: string): number {
  return cacheLimits[collection] ?? DEFAULT_LRU_CAPACITY
}

/**
 * A Map wrapper with LRU eviction. JS Maps iterate in insertion order,
 * so the *first* key is the least-recently-used entry.
 */
export class LRUMap<K, V> {
  private readonly map = new Map<K, V>()
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)!
    // Move to end (most-recently-used)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key)
    }
    this.map.set(key, value)
    // Evict oldest if over capacity
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
    return this
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  keys(): MapIterator<K> {
    return this.map.keys()
  }

  values(): MapIterator<V> {
    return this.map.values()
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries()
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map[Symbol.iterator]()
  }
}

/** Per-collection LRU cache of raw JSON strings, keyed by record id. */
export const collectionCache: Map<string, LRUMap<string, string>> =
  hmrSingleton('__swarmclaw_storage_collection_cache__', () => new Map<string, LRUMap<string, string>>())

/** TTL caches created by createCollectionStore (factory caches). */
export const factoryTtlCaches = hmrSingleton('__swarmclaw_factory_ttl__', () => new Map<string, TTLCache<Record<string, unknown>>>())
