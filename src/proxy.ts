import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE_NAME } from '@/lib/auth'
import {
  buildPluginInstallCorsHeaders,
  isPluginInstallCorsPath,
  resolvePluginInstallCorsOrigin,
} from '@/lib/plugin-install-cors'
import { isProductionRuntime } from '@/lib/runtime/runtime-env'
import { hmrSingleton } from '@/lib/shared-utils'

/* ------------------------------------------------------------------ */
/*  Rate-limit state — HMR-safe via globalThis                        */
/* ------------------------------------------------------------------ */

interface RateLimitEntry {
  count: number
  lockedUntil: number
}

const rateLimitMap = hmrSingleton('__swarmclaw_rate_limit__', () => new Map<string, RateLimitEntry>())

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes
const PRUNE_THRESHOLD = 1000

function isRateLimitEnabled(): boolean {
  return isProductionRuntime()
}

/** Prune expired entries when the map grows too large. */
function pruneRateLimitMap() {
  if (rateLimitMap.size <= PRUNE_THRESHOLD) return
  const now = Date.now()
  rateLimitMap.forEach((entry, ip) => {
    if (entry.lockedUntil < now && entry.count < MAX_ATTEMPTS) {
      rateLimitMap.delete(ip)
    }
  })
}

/** Extract client IP from the request. */
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return (request as unknown as { ip?: string }).ip ?? 'unknown'
}

function withPluginInstallCorsHeaders(pathname: string, origin: string | null, headers?: HeadersInit): Headers {
  const merged = new Headers(headers)
  if (!isPluginInstallCorsPath(pathname)) return merged
  const corsHeaders = buildPluginInstallCorsHeaders(origin)
  new Headers(corsHeaders).forEach((value, key) => {
    merged.set(key, value)
  })
  return merged
}

/* ------------------------------------------------------------------ */
/*  Proxy                                                              */
/* ------------------------------------------------------------------ */

/** Access key auth proxy with brute-force rate limiting.
 *  Checks X-Access-Key header or auth cookie on all /api/ routes except /api/auth.
 *  The key is validated against the ACCESS_KEY env var.
 *  After 5 failed attempts from a single IP the client is locked out for 15 minutes.
 */
export function proxy(request: NextRequest) {
  const rateLimitEnabled = isRateLimitEnabled()
  const { pathname } = request.nextUrl
  const corsOrigin = resolvePluginInstallCorsOrigin(request.headers.get('origin'))
  const isWebhookTrigger = request.method === 'POST'
    && /^\/api\/webhooks\/[^/]+\/?$/.test(pathname)
  const isConnectorWebhook = request.method === 'POST'
    && /^\/api\/connectors\/[^/]+\/webhook\/?$/.test(pathname)

  if (request.method === 'OPTIONS' && isPluginInstallCorsPath(pathname)) {
    if (!corsOrigin) {
      return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
    }
    return new NextResponse(null, {
      status: 204,
      headers: buildPluginInstallCorsHeaders(corsOrigin),
    })
  }

  // Only protect API routes (not auth or inbound webhooks)
  if (
    !pathname.startsWith('/api/')
    || pathname === '/api/auth'
    || isWebhookTrigger
    || isConnectorWebhook
  ) {
    return NextResponse.next()
  }

  const accessKey = process.env.ACCESS_KEY
  if (!accessKey) {
    // No key configured — allow all (dev mode)
    return NextResponse.next()
  }

  // --- Rate-limit housekeeping ---
  if (rateLimitEnabled) pruneRateLimitMap()

  const clientIp = getClientIp(request)
  const entry = rateLimitEnabled ? rateLimitMap.get(clientIp) : undefined

  // Check lockout before even validating the key
  if (rateLimitEnabled && entry && entry.lockedUntil > Date.now()) {
    const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again later.', retryAfter },
      {
        status: 429,
        headers: withPluginInstallCorsHeaders(pathname, corsOrigin, { 'Retry-After': String(retryAfter) }),
      },
    )
  }

  const cookieKey = request.cookies.get(AUTH_COOKIE_NAME)?.value?.trim() || ''
  const headerKey = request.headers.get('x-access-key')?.trim() || ''
  const providedKey = cookieKey || headerKey

  if (providedKey !== accessKey) {
    let remaining = MAX_ATTEMPTS
    if (rateLimitEnabled) {
      const current = rateLimitMap.get(clientIp) ?? { count: 0, lockedUntil: 0 }
      current.count += 1

      if (current.count >= MAX_ATTEMPTS) {
        current.lockedUntil = Date.now() + LOCKOUT_MS
      }

      rateLimitMap.set(clientIp, current)
      remaining = Math.max(0, MAX_ATTEMPTS - current.count)
    }
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: withPluginInstallCorsHeaders(pathname, corsOrigin, { 'X-RateLimit-Remaining': String(remaining) }),
      },
    )
  }

  // Successful auth — clear any prior failed-attempt tracking for this IP
  if (rateLimitEnabled && entry) {
    rateLimitMap.delete(clientIp)
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
