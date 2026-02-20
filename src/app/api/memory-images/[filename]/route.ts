import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const IMAGES_DIR = path.join(process.cwd(), 'data', 'memory-images')

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
}

export async function GET(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(IMAGES_DIR, safeName)

  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 })
  }

  const ext = path.extname(safeName).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const data = fs.readFileSync(filePath)

  return new NextResponse(data, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
