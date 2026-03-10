const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g
const LEADING_DASH_RE = /^-+/
const TRAILING_DASH_RE = /-+$/

export function normalizeOpenClawAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) {
    return 'main'
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, '-')
      .replace(LEADING_DASH_RE, '')
      .replace(TRAILING_DASH_RE, '')
      .slice(0, 64)
    || 'main'
  )
}

export function buildOpenClawMainSessionKey(agentNameOrId: string | undefined | null): string | null {
  const trimmed = (agentNameOrId ?? '').trim()
  if (!trimmed) {
    return null
  }
  return `agent:${normalizeOpenClawAgentId(trimmed)}:main`
}
