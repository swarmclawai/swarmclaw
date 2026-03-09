/**
 * Shared utility functions used across the codebase.
 *
 * These replace ad-hoc patterns that were duplicated in 100+ files:
 * - errorMessage: 231 occurrences across 112 files
 * - safeJsonParse: 137 occurrences across 82 files
 * - truncate: 62+ occurrences across 20+ files
 * - hmrSingleton: 77 occurrences across 38 files
 * - dedup/dedupBy: 40 occurrences across 28 files
 * - sleep: 25 occurrences across 17 files
 */

/** Extract a human-readable error message from an unknown catch value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Parse JSON with a fallback value instead of throwing. */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** Truncate a string to `limit` characters, optionally appending a suffix. */
export function truncate(s: string, limit: number, suffix = ''): string {
  if (s.length <= limit) return s
  const cutoff = Math.max(0, limit - suffix.length)
  return s.slice(0, cutoff) + suffix
}

/**
 * HMR-safe singleton on globalThis. Survives Next.js hot module reloads.
 * Replaces the ad-hoc `__swarmclaw_*` pattern scattered across 38 files.
 */
export function hmrSingleton<T>(key: string, init: () => T): T {
  const g = globalThis as Record<string, unknown>
  return (g[key] ??= init()) as T
}

/** Deduplicate an array preserving insertion order. */
export function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

/** Deduplicate an array by a key function, keeping the first occurrence. */
export function dedupBy<T>(arr: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return arr.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Promise-based sleep. Replaces `await new Promise(r => setTimeout(r, ms))`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
