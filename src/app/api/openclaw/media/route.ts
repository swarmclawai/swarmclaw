import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'
import { lookup } from 'mime-types'

const MAX_SIZE = 25 * 1024 * 1024 // 25MB

/** GET ?path=... — proxy agent files (images etc.) from gateway */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const filePath = searchParams.get('path')
  if (!filePath) {
    return NextResponse.json({ error: 'Missing path' }, { status: 400 })
  }

  // Security: path must be under ~/.openclaw/
  if (!filePath.includes('.openclaw') && !filePath.includes('.clawdbot')) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    const result = await gw.rpc('files.read', { path: filePath }) as { content?: string; encoding?: string } | undefined
    if (!result?.content) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const isBase64 = result.encoding === 'base64'
    const buf = isBase64
      ? Buffer.from(result.content, 'base64')
      : Buffer.from(result.content, 'utf-8')

    if (buf.length > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large' }, { status: 413 })
    }

    const mimeType = lookup(filePath) || 'application/octet-stream'

    return new NextResponse(buf, {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=300',
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
