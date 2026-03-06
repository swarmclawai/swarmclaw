import { NextResponse } from 'next/server'
import { validateAccessKey, isFirstTimeSetup, markSetupComplete } from '@/lib/server/storage'
import { ensureDaemonStarted } from '@/lib/server/daemon-state'
import { AUTH_COOKIE_NAME, getCookieValue } from '@/lib/auth'
export const dynamic = 'force-dynamic'

interface AuthAttemptEntry {
  count: number
  lockedUntil: number
}

const authRateLimitMap = (
  (globalThis as Record<string, unknown>).__swarmclaw_auth_rate_limit__ ??= new Map()
) as Map<string, AuthAttemptEntry>

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

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

/** GET /api/auth — returns setup state and whether the auth cookie is currently valid */
export async function GET(req: Request) {
  const cookieKey = getCookieValue(req.headers.get('cookie'), AUTH_COOKIE_NAME)
  return NextResponse.json({
    firstTime: isFirstTimeSetup(),
    authenticated: !!cookieKey && validateAccessKey(cookieKey),
  })
}

/** POST /api/auth — validate an access key */
export async function POST(req: Request) {
  const clientIp = getClientIp(req)
  const entry = authRateLimitMap.get(clientIp)
  if (entry && entry.lockedUntil > Date.now()) {
    const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return clearAuthCookie(NextResponse.json(
      { error: 'Too many failed attempts. Try again later.', retryAfter },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    ))
  }

  const { key } = await req.json()
  if (!key || !validateAccessKey(key)) {
    const current = authRateLimitMap.get(clientIp) ?? { count: 0, lockedUntil: 0 }
    current.count += 1
    if (current.count >= MAX_ATTEMPTS) {
      current.lockedUntil = Date.now() + LOCKOUT_MS
    }
    authRateLimitMap.set(clientIp, current)
    return clearAuthCookie(NextResponse.json(
      { error: 'Invalid access key' },
      {
        status: 401,
        headers: { 'X-RateLimit-Remaining': String(Math.max(0, MAX_ATTEMPTS - current.count)) },
      },
    ))
  }

  authRateLimitMap.delete(clientIp)
  // If this was first-time setup, mark it as claimed
  if (isFirstTimeSetup()) {
    markSetupComplete()
  }
  ensureDaemonStarted('api/auth:post')
  return setAuthCookie(NextResponse.json({ ok: true }), req, key)
}
