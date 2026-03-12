import { NextResponse } from 'next/server'
import { getAccessKey, validateAccessKey, isFirstTimeSetup, markSetupComplete, replaceAccessKey } from '@/lib/server/storage'
import { AUTH_COOKIE_NAME, getCookieValue } from '@/lib/auth'
import { isProductionRuntime } from '@/lib/runtime/runtime-env'
import { hmrSingleton } from '@/lib/shared-utils'
export const dynamic = 'force-dynamic'

interface AuthAttemptEntry {
  count: number
  lockedUntil: number
}

const authRateLimitMap = hmrSingleton('__swarmclaw_auth_rate_limit__', () => new Map<string, AuthAttemptEntry>())

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

function isRateLimitEnabled(): boolean {
  return isProductionRuntime()
}

function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = req.headers.get('x-real-ip')?.trim()
  return realIp || 'unknown'
}

function clearAuthCookie(response: NextResponse): NextResponse {
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 0,
  })
  return response
}

function setAuthCookie(response: NextResponse, req: Request, key: string): NextResponse {
  response.cookies.set(AUTH_COOKIE_NAME, key, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return response
}

/** GET /api/auth — returns setup state and whether the auth cookie is currently valid.
 *  During first-time setup the generated access key is included so the UI can
 *  display it with a copy button. Once setup completes the key is never exposed
 *  over an unauthenticated endpoint again. */
export async function GET(req: Request) {
  const cookieKey = getCookieValue(req.headers.get('cookie'), AUTH_COOKIE_NAME)
  const firstTime = isFirstTimeSetup()
  return NextResponse.json({
    firstTime,
    authenticated: !!cookieKey && validateAccessKey(cookieKey),
    ...(firstTime ? { generatedKey: getAccessKey() } : {}),
  })
}

/** POST /api/auth — validate an access key */
export async function POST(req: Request) {
  const rateLimitEnabled = isRateLimitEnabled()
  const clientIp = getClientIp(req)
  const entry = rateLimitEnabled ? authRateLimitMap.get(clientIp) : undefined
  if (rateLimitEnabled && entry && entry.lockedUntil > Date.now()) {
    const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return clearAuthCookie(NextResponse.json(
      { error: 'Too many failed attempts. Try again later.', retryAfter },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    ))
  }

  const { key, override } = await req.json()

  // During first-time setup, allow the user to replace the generated key with their own
  if (override && isFirstTimeSetup() && typeof key === 'string' && key.trim().length >= 8) {
    replaceAccessKey(key.trim())
    markSetupComplete()
    if (rateLimitEnabled) authRateLimitMap.delete(clientIp)
    const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
    ensureDaemonStarted('api/auth:post')
    return setAuthCookie(NextResponse.json({ ok: true }), req, key.trim())
  }

  if (!key || !validateAccessKey(key)) {
    let remaining = MAX_ATTEMPTS
    if (rateLimitEnabled) {
      const current = authRateLimitMap.get(clientIp) ?? { count: 0, lockedUntil: 0 }
      current.count += 1
      if (current.count >= MAX_ATTEMPTS) {
        current.lockedUntil = Date.now() + LOCKOUT_MS
      }
      authRateLimitMap.set(clientIp, current)
      remaining = Math.max(0, MAX_ATTEMPTS - current.count)
    }
    return clearAuthCookie(NextResponse.json(
      { error: 'Invalid access key' },
      {
        status: 401,
        headers: { 'X-RateLimit-Remaining': String(remaining) },
      },
    ))
  }

  if (rateLimitEnabled) authRateLimitMap.delete(clientIp)
  // If this was first-time setup, mark it as claimed
  if (isFirstTimeSetup()) {
    markSetupComplete()
  }
  const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
  ensureDaemonStarted('api/auth:post')
  return setAuthCookie(NextResponse.json({ ok: true }), req, key)
}
