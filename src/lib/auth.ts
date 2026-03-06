export const AUTH_COOKIE_NAME = 'sc_auth'

export function getCookieValue(cookieHeader: string | null | undefined, name: string): string {
  if (!cookieHeader) return ''
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const [rawKey, ...rest] = part.split('=')
    if (!rawKey || rest.length === 0) continue
    if (rawKey.trim() !== name) continue
    try {
      return decodeURIComponent(rest.join('=').trim())
    } catch {
      return rest.join('=').trim()
    }
  }
  return ''
}
