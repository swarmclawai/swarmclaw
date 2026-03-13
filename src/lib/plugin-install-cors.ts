const DEFAULT_ALLOWED_ORIGINS = [
  'https://swarmclaw.ai',
  'https://www.swarmclaw.ai',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_ALLOWED_ORIGINS
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_ORIGINS
}

function normalizeOrigin(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}

export function resolvePluginInstallCorsOrigin(rawOrigin: string | null | undefined): string | null {
  const origin = normalizeOrigin(rawOrigin)
  if (!origin) return null
  const allowed = parseAllowedOrigins(process.env.SWARMCLAW_PLUGIN_INSTALL_ORIGINS)
  return allowed.includes(origin) ? origin : null
}

export function buildPluginInstallCorsHeaders(origin: string | null): HeadersInit {
  const headers = new Headers()
  headers.set('Vary', 'Origin')
  if (!origin) return headers
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Access-Key')
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  headers.set('Access-Control-Max-Age', '600')
  return headers
}

export function isPluginInstallCorsPath(pathname: string): boolean {
  return pathname === '/api/extensions/install'
}
