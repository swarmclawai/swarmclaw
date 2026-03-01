import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.sh': 'text/plain',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

export async function GET(req: Request) {
  const url = new URL(req.url)
  const filePath = url.searchParams.get('path')

  if (!filePath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 })
  }

  // Resolve and normalize the path
  const resolved = path.resolve(filePath)

  // Block access to sensitive paths
  const blocked = ['.env', 'credentials', '.ssh', '.gnupg', '.aws']
  if (blocked.some((b) => resolved.includes(b))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  const stat = fs.statSync(resolved)
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'Not a file' }, { status: 400 })
  }
  if (stat.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large' }, { status: 413 })
  }

  const ext = path.extname(resolved).toLowerCase()
  const contentType = MIME_MAP[ext] || 'application/octet-stream'
  const content = fs.readFileSync(resolved)

  return new NextResponse(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': contentType.startsWith('text/') || contentType.startsWith('image/')
        ? 'inline'
        : `attachment; filename="${path.basename(resolved)}"`,
    },
  })
}
