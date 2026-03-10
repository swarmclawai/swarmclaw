/**
 * Relative time formatting utility.
 *
 * Canonical implementation — all components should import from here
 * instead of defining their own `timeAgo`.
 */

/** Returns a human-readable relative time string like "3m ago" or "2d ago". */
export function timeAgo(ts: number, now?: number | null): string {
  if (!ts) return ''
  if (!now) return 'recently'
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/** Compact variant without "ago" suffix — used in tight layouts like chat cards. */
export function timeAgoShort(ts: number, now?: number | null): string {
  if (!ts) return ''
  if (!now) return 'recently'
  const s = Math.floor((now - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

/** Returns a future-looking string like "in 3m" or "in 2h". */
export function timeUntil(ts: number, now?: number | null): string {
  if (!now) return 'soon'
  const diff = ts - now
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}
