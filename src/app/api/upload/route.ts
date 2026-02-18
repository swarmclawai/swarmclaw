import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { UPLOAD_DIR } from '@/lib/server/storage'

export async function POST(req: Request) {
  const filename = req.headers.get('x-filename') || 'image.png'
  const buf = Buffer.from(await req.arrayBuffer())
  const name = crypto.randomBytes(4).toString('hex') + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = path.join(UPLOAD_DIR, name)

  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  fs.writeFileSync(filePath, buf)
  console.log(`[upload] saved ${buf.length} bytes to ${filePath}`)

  return NextResponse.json({ path: filePath, size: buf.length, url: `/api/uploads/${name}` })
}
