import { NextResponse } from 'next/server'
import { getPluginManager, sanitizePluginFilename } from '@/lib/server/plugins'

export async function POST(req: Request) {
  const body = await req.json()
  const url = typeof body?.url === 'string' ? body.url : ''
  const filename = typeof body?.filename === 'string' ? body.filename : ''

  if (!url || !url.startsWith('https://')) {
    return NextResponse.json(
      { error: 'URL must be a valid HTTPS URL' },
      { status: 400 },
    )
  }

  try {
    const sanitizedFilename = sanitizePluginFilename(filename)
    const installed = await getPluginManager().installPluginFromUrl(url, sanitizedFilename)
    return NextResponse.json({ ok: true, filename: installed.filename, hash: installed.sourceHash })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const isTimeout = /abort|timeout/i.test(msg)
    const status = /valid HTTPS URL|Filename|Invalid filename|HTML page|too large/i.test(msg)
      ? 400
      : isTimeout
        ? 504
        : 500
    return NextResponse.json(
      { error: isTimeout ? 'Download timed out — the plugin URL may be unreachable' : msg },
      { status },
    )
  }
}
