import { NextResponse } from 'next/server'
import { getPluginManager, sanitizePluginFilename } from '@/lib/server/plugins'
import { errorMessage } from '@/lib/shared-utils'
import {
  inferPluginInstallSourceFromUrl,
  inferPluginPublisherSourceFromUrl,
  normalizePluginInstallSource,
  normalizePluginPublisherSource,
} from '@/lib/plugin-sources'
import {
  buildPluginInstallCorsHeaders,
  resolvePluginInstallCorsOrigin,
} from '@/lib/plugin-install-cors'

function json(body: Record<string, unknown>, status: number, origin: string | null) {
  return NextResponse.json(body, {
    status,
    headers: buildPluginInstallCorsHeaders(origin),
  })
}

export async function OPTIONS(req: Request) {
  const origin = resolvePluginInstallCorsOrigin(req.headers.get('origin'))
  if (!origin) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
  return new NextResponse(null, {
    status: 204,
    headers: buildPluginInstallCorsHeaders(origin),
  })
}

export async function POST(req: Request) {
  const origin = resolvePluginInstallCorsOrigin(req.headers.get('origin'))
  const body = await req.json()
  const url = typeof body?.url === 'string' ? body.url : ''
  const filename = typeof body?.filename === 'string' ? body.filename : ''
  const installMethod = body?.installMethod === 'marketplace' ? 'marketplace' : 'manual'
  const sourceLabel = normalizePluginPublisherSource(body?.sourceLabel)
    || inferPluginPublisherSourceFromUrl(url)
    || 'manual'
  const installSource = normalizePluginInstallSource(body?.installSource)
    || inferPluginInstallSourceFromUrl(url)
    || 'manual'

  if (!url || !url.startsWith('https://')) {
    return json(
      { error: 'URL must be a valid HTTPS URL' },
      400,
      origin,
    )
  }

  try {
    const sanitizedFilename = sanitizePluginFilename(filename)
    const installed = await getPluginManager().installPluginFromUrl(url, sanitizedFilename, {
      source: installMethod,
      sourceLabel,
      installSource,
    })
    return json({ ok: true, filename: installed.filename, hash: installed.sourceHash }, 200, origin)
  } catch (err: unknown) {
    const msg = errorMessage(err)
    const isTimeout = /abort|timeout/i.test(msg)
    const status = /valid HTTPS URL|Filename|Invalid filename|HTML page|too large/i.test(msg)
      ? 400
      : isTimeout
        ? 504
        : 500
    return json(
      { error: isTimeout ? 'Download timed out — the plugin URL may be unreachable' : msg },
      status,
      origin,
    )
  }
}
