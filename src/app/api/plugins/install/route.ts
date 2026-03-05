import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getPluginManager } from '@/lib/server/plugins'

const PLUGINS_DIR = path.join(process.cwd(), 'data', 'plugins')

function toRawUrl(url: string): string {
  if (url.includes('github.com') && url.includes('/blob/')) {
    return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
  }
  if (url.includes('gist.github.com')) {
    return url.endsWith('/raw') ? url : `${url}/raw`
  }
  return url
}

function normalizeMarketplaceUrl(url: string): string {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) return trimmed

  let normalized = trimmed
    .replace('github.com/swarmclawai/plugins/', 'github.com/swarmclawai/swarmforge/')
    .replace('raw.githubusercontent.com/swarmclawai/plugins/', 'raw.githubusercontent.com/swarmclawai/swarmforge/')

  normalized = toRawUrl(normalized)

  // Legacy registry entries used master and old repo names.
  normalized = normalized
    .replace('/swarmclawai/swarmforge/master/', '/swarmclawai/swarmforge/main/')
    .replace('/swarmclawai/plugins/master/', '/swarmclawai/swarmforge/main/')
    .replace('/swarmclawai/plugins/main/', '/swarmclawai/swarmforge/main/')

  return normalized
}

export async function POST(req: Request) {
  const body = await req.json()
  const { url, filename } = body
  const rawUrl = normalizeMarketplaceUrl(url)

  // Validate URL
  if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
    return NextResponse.json(
      { error: 'URL must be a valid HTTPS URL' },
      { status: 400 },
    )
  }

  // Validate filename
  if (!filename || typeof filename !== 'string' || !filename.endsWith('.js')) {
    return NextResponse.json(
      { error: 'Filename must end in .js' },
      { status: 400 },
    )
  }

  // Path traversal protection
  const sanitized = path.basename(filename)
  if (sanitized !== filename || filename.includes('..')) {
    return NextResponse.json(
      { error: 'Invalid filename' },
      { status: 400 },
    )
  }

  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      return NextResponse.json(
        { error: `Download failed (HTTP ${res.status}) from ${rawUrl}` },
        { status: 502 },
      )
    }
    const contentType = res.headers.get('content-type') || ''
    let code = await res.text()

    // Reject HTML responses (likely a GitHub page, not raw content)
    if (contentType.includes('text/html') && code.includes('<!DOCTYPE')) {
      return NextResponse.json(
        { error: 'URL returned an HTML page instead of JavaScript. Use a raw/direct link to the .js file.' },
        { status: 400 },
      )
    }

    // Compatibility fix: Strip node-fetch requires if present, as modern Node has global fetch
    code = code.replace(/const\s+fetch\s*=\s*require\(['"]node-fetch['"]\);?/g, '// node-fetch stripped for compatibility')
    code = code.replace(/import\s+fetch\s+from\s+['"]node-fetch['"];?/g, '// node-fetch stripped for compatibility')

    // Ensure plugins directory exists
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true })
    }

    const dest = path.join(PLUGINS_DIR, sanitized)
    fs.writeFileSync(dest, code, 'utf8')

    // Force plugin manager to re-scan so the new plugin appears in listings
    getPluginManager().reload()

    return NextResponse.json({ ok: true, filename: sanitized })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const isTimeout = msg.includes('abort') || msg.includes('timeout')
    return NextResponse.json(
      { error: isTimeout ? 'Download timed out — the plugin URL may be unreachable' : `Install failed: ${msg}` },
      { status: isTimeout ? 504 : 500 },
    )
  }
}
