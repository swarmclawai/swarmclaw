'use client'

type ReportClientErrorInput = {
  source: string
  error: Error | string | unknown
  componentStack?: string | null
  digest?: string | null
}

const reportedClientErrors = new Set<string>()

function truncate(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? value.slice(0, max) : value
}

export function reportClientError(input: ReportClientErrorInput) {
  if (typeof window === 'undefined') return

  const message = input.error instanceof Error
    ? input.error.message
    : typeof input.error === 'string'
      ? input.error
      : String(input.error)

  const stack = input.error instanceof Error ? input.error.stack : undefined
  const fingerprint = [
    input.source,
    message,
    input.digest || '',
    input.componentStack || '',
  ].join('|')

  if (reportedClientErrors.has(fingerprint)) return
  reportedClientErrors.add(fingerprint)

  void fetch('/api/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: input.source,
      message: truncate(message, 1000),
      stack: truncate(stack, 8000),
      componentStack: truncate(input.componentStack, 8000),
      digest: truncate(input.digest, 200),
      url: truncate(window.location.href, 2000),
      pathname: truncate(window.location.pathname, 1000),
      userAgent: truncate(window.navigator.userAgent, 1000),
    }),
    keepalive: true,
  }).catch(() => {})
}
