import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { UPLOAD_DIR } from '@/lib/server/storage'

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.rb', '.php', '.sh', '.bash', '.zsh', '.sql', '.r', '.swift', '.kt',
  '.env', '.log', '.conf', '.properties', '.gitignore', '.dockerignore',
])

function isTextFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return TEXT_EXTS.has(ext) || ext === ''
}

function deriveTitle(filename: string): string {
  const name = path.basename(filename, path.extname(filename))
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Uploaded Document'
}

export async function POST(req: Request) {
  const filename = req.headers.get('x-filename') || 'document.txt'
  const buf = Buffer.from(await req.arrayBuffer())

  if (buf.length === 0) {
    return NextResponse.json({ error: 'Empty file.' }, { status: 400 })
  }

  if (buf.length > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 10MB.' }, { status: 400 })
  }

  // Save file to uploads
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const safeName = crypto.randomBytes(4).toString('hex') + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = path.join(UPLOAD_DIR, safeName)
  fs.writeFileSync(filePath, buf)

  // Extract text content
  let content = ''
  const ext = path.extname(filename).toLowerCase()

  if (ext === '.pdf') {
    // Try dynamic import of pdf-parse if available
    try {
      // @ts-ignore — pdf-parse is an optional dependency
      const pdfParse = (await import(/* webpackIgnore: true */ 'pdf-parse')).default
      const result = await pdfParse(buf)
      content = result.text || ''
    } catch {
      // pdf-parse not installed — read as raw text fallback
      content = '[PDF document — install pdf-parse for text extraction]\n\nFile saved at: ' + filePath
    }
  } else if (isTextFile(filename)) {
    content = buf.toString('utf-8')
  } else {
    // Binary file — can't extract text
    content = `[Binary file: ${filename}]\n\nFile saved at: ${filePath}`
  }

  // Truncate very long content to prevent memory issues
  const MAX_CONTENT = 500_000
  if (content.length > MAX_CONTENT) {
    content = content.slice(0, MAX_CONTENT) + '\n\n[... truncated at 500k characters]'
  }

  const title = deriveTitle(filename)
  const url = `/api/uploads/${safeName}`

  return NextResponse.json({
    title,
    content,
    filePath,
    url,
    filename,
    size: buf.length,
  })
}
