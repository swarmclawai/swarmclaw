import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '@/lib/server/storage'
import { MIME_TYPES } from '@/lib/server/mime'

export async function GET(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(UPLOAD_DIR, safeName)

  if (!fs.existsSync(filePath)) {
    return notFound()
  }

  const ext = path.extname(safeName).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const data = fs.readFileSync(filePath)

  const inline = contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('text/') || contentType === 'application/pdf'
  return new NextResponse(data, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${path.basename(safeName)}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '')

  if (safeName.includes('..') || safeName.includes('/')) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  const filePath = path.join(UPLOAD_DIR, safeName)

  if (!fs.existsSync(filePath)) {
    return notFound()
  }

  fs.unlinkSync(filePath)
  return NextResponse.json({ ok: true })
}
