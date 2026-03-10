export type ToolArgsRecord = Record<string, unknown>
const NESTED_WRAPPER_KEYS = ['input', 'args', 'arguments', 'payload', 'parameters', 'data'] as const

function parseRecordCandidate(value: unknown): ToolArgsRecord | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as ToolArgsRecord
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ToolArgsRecord
    }
  } catch {
    // ignore non-JSON strings
  }
  return null
}

/**
 * Normalize common wrapper payloads used by older tool callers.
 *
 * Supports payloads nested under `input`, `args`, `arguments`, or `payload`
 * as either objects or JSON strings.
 */
export function normalizeToolInputArgs(rawArgs: ToolArgsRecord): ToolArgsRecord {
  const normalized: ToolArgsRecord = {}
  const queue: ToolArgsRecord[] = [rawArgs]
  const visited = new Set<ToolArgsRecord>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current)) continue
    visited.add(current)

    for (const key of NESTED_WRAPPER_KEYS) {
      const nested = parseRecordCandidate(current[key])
      if (nested) queue.push(nested)
    }

    for (const [key, value] of Object.entries(current)) {
      if (value === undefined || value === null) continue
      if (!(key in normalized)) normalized[key] = value
    }
  }

  return normalized
}
