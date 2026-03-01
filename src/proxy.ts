import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/* ------------------------------------------------------------------ */
/*  Rate-limit state — HMR-safe via globalThis                        */
/* ------------------------------------------------------------------ */

interface RateLimitEntry {
  count: number
  lockedUntil: number
}

const rateLimitMap = (
  (globalThis as Record<string, unknown>).__swarmclaw_rate_limit__ ??= new Map()
) as Map<string, RateLimitEntry>

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes
const PRUNE_THRESHOLD = 1000

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

/* ------------------------------------------------------------------ */
/*  Proxy                                                              */
/* ------------------------------------------------------------------ */

/** Access key auth proxy with brute-force rate limiting.
 *  Checks X-Access-Key header or ?key= param on all /api/ routes except /api/auth.
 *  The key is validated against the ACCESS_KEY env var.
 *  After 5 failed attempts from a single IP the client is locked out for 15 minutes.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isWebhookTrigger = request.method === 'POST'
    && /^\/api\/webhooks\/[^/]+\/?$/.test(pathname)
  const isConnectorWebhook = request.method === 'POST'
    && /^\/api\/connectors\/[^/]+\/webhook\/?$/.test(pathname)

  // Only protect API routes (not auth, uploads served as static assets, or inbound webhooks)
  if (
    !pathname.startsWith('/api/')
    || pathname === '/api/auth'
    || pathname.startsWith('/api/uploads/')
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
  pruneRateLimitMap()

  const clientIp = getClientIp(request)
  const entry = rateLimitMap.get(clientIp)

  // Check lockout before even validating the key
  if (entry && entry.lockedUntil > Date.now()) {
    const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again later.', retryAfter },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    )
  }

  const providedKey =
    request.headers.get('x-access-key')
    || request.nextUrl.searchParams.get('key')
    || ''

  if (providedKey !== accessKey) {
    // Record the failed attempt
    const current = rateLimitMap.get(clientIp) ?? { count: 0, lockedUntil: 0 }
    current.count += 1

    if (current.count >= MAX_ATTEMPTS) {
      current.lockedUntil = Date.now() + LOCKOUT_MS
    }

    rateLimitMap.set(clientIp, current)

    const remaining = Math.max(0, MAX_ATTEMPTS - current.count)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'X-RateLimit-Remaining': String(remaining) } },
    )
  }

  // Successful auth — clear any prior failed-attempt tracking for this IP
  if (entry) {
    rateLimitMap.delete(clientIp)
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
