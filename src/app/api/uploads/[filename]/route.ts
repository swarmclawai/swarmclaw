import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '@/lib/server/storage'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

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
