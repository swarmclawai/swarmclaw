/**
 * Display formatting utilities.
 *
 * Canonical implementations — import from here instead of defining
 * local copies in component files.
 */

/** Format a token count: 1234567 → "1.2M", 3500 → "3.5K", 42 → "42" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Format a cost value: 0.0042 → "$0.0042" */
export function formatCost(n: number, decimals = 4): string {
  return `$${n.toFixed(decimals)}`
}

/** Format a byte count: 1536 → "1.5 KB", 0 → "0 B" */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * - `formatDurationMs(450)` → `"450ms"`
 * - `formatDurationMs(3200)` → `"3.2s"`
 * - `formatDurationMs(125_000)` → `"2m"`
 * - `formatDurationMs(7_500_000)` → `"2.1h"`
 */
export function formatDurationMs(ms: number): string {
  if (!ms) return '—'
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/**
 * Format a duration in seconds to a compact string (no sub-second precision).
 *
 * - `formatDurationSec(45)` → `"45s"`
 * - `formatDurationSec(125)` → `"2m"`
 * - `formatDurationSec(7500)` → `"2h5m"`
 */
export function formatDurationSec(sec: number): string {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m`
  return `${sec}s`
}

/**
 * Format elapsed time between two timestamps (ms).
 * Falls back to `now` when `end` is not yet known (in-progress run).
 */
export function formatElapsed(start: number | undefined, end: number | undefined, now: number | null): string {
  if (!start) return '-'
  if (!end && !now) return '-'
  const elapsed = (end || now || start) - start
  if (elapsed < 1_000) return `${elapsed}ms`
  if (elapsed < 60_000) return `${(elapsed / 1_000).toFixed(1)}s`
  return `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1_000)}s`
}
