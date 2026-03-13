/**
 * Temporal Decay for Memory Search
 *
 * Applies exponential decay to memory search scores based on entry age.
 * Older memories score lower, surfacing recent relevant context preferentially.
 * Inspired by OpenClaw's temporal-decay.ts.
 */

export interface TemporalDecayConfig {
  /** Whether temporal decay is enabled (default: true) */
  enabled: boolean
  /** Half-life in days — after this many days, a memory's score decays to 50% (default: 30) */
  halfLifeDays: number
}

export const DEFAULT_TEMPORAL_DECAY: TemporalDecayConfig = {
  enabled: true,
  halfLifeDays: 30,
}

/**
 * Calculate the temporal decay multiplier for a given age.
 * Returns a value in (0, 1] where 1.0 = no decay (just created).
 */
export function calculateTemporalDecayMultiplier(ageInDays: number, halfLifeDays: number): number {
  if (ageInDays <= 0 || halfLifeDays <= 0) return 1.0
  const lambda = Math.LN2 / halfLifeDays
  return Math.exp(-lambda * ageInDays)
}

/** Categories exempt from temporal decay (evergreen/reference content) */
const DECAY_EXEMPT_CATEGORIES = new Set([
  'core',
  'core/identity',
  'core/rules',
  'reference',
  'reference/docs',
  'reflection/invariant',
  'reflection/communication',
  'reflection/relationship',
  'reflection/significant_event',
  'reflection/profile',
  'reflection/boundary',
])

/**
 * Determine whether a memory entry is exempt from temporal decay.
 * Pinned memories and core/reference categories are evergreen.
 */
export function isDecayExempt(entry: { pinned?: boolean; category?: string }): boolean {
  if (entry.pinned) return true
  if (entry.category && DECAY_EXEMPT_CATEGORIES.has(entry.category)) return true
  return false
}
