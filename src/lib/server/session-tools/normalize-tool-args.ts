export type ToolArgsRecord = Record<string, unknown>

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
  const nestedSources: Array<ToolArgsRecord | null> = [
    parseRecordCandidate(rawArgs.input),
    parseRecordCandidate(rawArgs.args),
    parseRecordCandidate(rawArgs.arguments),
    parseRecordCandidate(rawArgs.payload),
  ]

  const normalized: ToolArgsRecord = {}
  for (const nested of nestedSources) {
    if (!nested) continue
    Object.assign(normalized, nested)
  }

  for (const [key, value] of Object.entries(rawArgs)) {
    if (value === undefined || value === null) continue
    normalized[key] = value
  }

  return normalized
}
