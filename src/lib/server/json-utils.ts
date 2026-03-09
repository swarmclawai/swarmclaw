export function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return fallback
  }
}

export function safeJsonParseObject<T extends object = Record<string, unknown>>(raw: unknown): T | null {
  const parsed = safeJsonParse<unknown>(raw, null)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as T
    : null
}

export function safeJsonParseArray<T = unknown>(raw: unknown): T[] | null {
  const parsed = safeJsonParse<unknown>(raw, null)
  return Array.isArray(parsed) ? parsed as T[] : null
}
