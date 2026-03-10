const DEFAULT_OPENCLAW_ENDPOINT = 'http://localhost:18789/v1'

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

function parseUrl(raw: string): URL | null {
  const value = raw.trim()
  if (!value) return null
  try {
    return new URL(hasScheme(value) ? value : `http://${value}`)
  } catch {
    return null
  }
}

function toHttpProtocol(protocol: string): string {
  if (protocol === 'ws:') return 'http:'
  if (protocol === 'wss:') return 'https:'
  return protocol
}

function cleanPath(pathname: string): string {
  let path = pathname.replace(/\/+$/, '')
  const lower = path.toLowerCase()

  if (lower.endsWith('/chat/completions')) {
    path = path.slice(0, -'/chat/completions'.length)
  }
  if (path.toLowerCase().endsWith('/models')) {
    path = path.slice(0, -'/models'.length)
  }

  path = path.replace(/\/+$/, '')
  if (!path || path === '/') return '/v1'
  if (!/\/v1$/i.test(path)) return `${path}/v1`
  return path
}

export function normalizeOpenClawEndpoint(input?: string | null): string {
  const parsed = parseUrl(input || '') || parseUrl(DEFAULT_OPENCLAW_ENDPOINT)!
  parsed.protocol = toHttpProtocol(parsed.protocol)
  parsed.pathname = cleanPath(parsed.pathname || '/')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

export function deriveOpenClawWsUrl(input?: string | null): string {
  const api = normalizeOpenClawEndpoint(input)
  const parsed = parseUrl(api) || parseUrl(DEFAULT_OPENCLAW_ENDPOINT)!
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  parsed.pathname = parsed.pathname.replace(/\/v1$/i, '') || '/'
  parsed.search = ''
  parsed.hash = ''
  const value = parsed.toString()
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function isLocalOpenClawEndpoint(input?: string | null): boolean {
  const parsed = parseUrl(input || '') || parseUrl(DEFAULT_OPENCLAW_ENDPOINT)!
  const host = parsed.hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

export function normalizeProviderEndpoint(provider: string | null | undefined, endpoint: string | null | undefined): string | null {
  if (typeof endpoint !== 'string') return null
  const trimmed = endpoint.trim()
  if (!trimmed) return null
  if (provider === 'openclaw') return normalizeOpenClawEndpoint(trimmed)
  return trimmed.replace(/\/+$/, '')
}
