export interface OTelConfig {
  enabled: true
  serviceName: string
  tracesEndpoint: string
  headers: Record<string, string>
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function cleanEnvValue(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function resolveOtelTracesEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const tracesEndpoint = cleanEnvValue(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
  if (tracesEndpoint) return tracesEndpoint.replace(/\/+$/, '')

  const baseEndpoint = cleanEnvValue(env.OTEL_EXPORTER_OTLP_ENDPOINT)
  if (!baseEndpoint) return null

  const normalizedBase = baseEndpoint.replace(/\/+$/, '')
  if (!normalizedBase) return null
  if (normalizedBase.endsWith('/v1/traces')) return normalizedBase
  return `${normalizedBase}/v1/traces`
}

export function parseOtelHeaders(value: string | undefined): Record<string, string> {
  if (typeof value !== 'string') return {}
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  const headers: Record<string, string> = {}
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = entry.slice(0, separatorIndex).trim()
    const headerValue = entry.slice(separatorIndex + 1).trim()
    if (!key || !headerValue) continue
    headers[key] = headerValue
  }
  return headers
}

export function resolveOtelConfig(env: NodeJS.ProcessEnv = process.env): OTelConfig | null {
  if (!parseBooleanFlag(env.OTEL_ENABLED)) return null

  const tracesEndpoint = resolveOtelTracesEndpoint(env)
  if (!tracesEndpoint) return null

  const serviceName = cleanEnvValue(env.OTEL_SERVICE_NAME) || 'swarmclaw'
  const headers = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS)

  return {
    enabled: true,
    serviceName,
    tracesEndpoint,
    headers,
  }
}
