const CONTROL_TOKEN_NAMES = ['NO_MESSAGE', 'HEARTBEAT_OK'] as const
const CONTROL_TOKEN_PREFIX_RE = /^\s*(?:NO_MESSAGE|HEARTBEAT_OK)(?:(?=[\s.,:;!?()[\]{}"'`-]|$)|(?=[A-Z]))\s*/i
const CONTROL_TOKEN_LINE_RE = /(^|\n)\s*(?:NO_MESSAGE|HEARTBEAT_OK)\s*(\n|$)/gi

export function stripHiddenControlTokens(text: string): string {
  let cleaned = String(text || '')
  let previous = ''

  while (cleaned !== previous) {
    previous = cleaned
    cleaned = cleaned.replace(CONTROL_TOKEN_PREFIX_RE, '')
  }

  cleaned = cleaned.replace(CONTROL_TOKEN_LINE_RE, '$1')
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

export function shouldSuppressHiddenControlText(text: string): boolean {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (!CONTROL_TOKEN_NAMES.some((token) => raw.toUpperCase().includes(token))) return false
  return stripHiddenControlTokens(raw).length === 0
}
