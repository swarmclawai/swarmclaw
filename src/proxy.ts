import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/** Simple access key auth proxy.
 *  Checks X-Access-Key header or ?key= param on all /api/ routes except /api/auth.
 *  The key is validated against the ACCESS_KEY env var.
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

  const providedKey =
    request.headers.get('x-access-key')
    || request.nextUrl.searchParams.get('key')
    || ''

  if (providedKey !== accessKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
