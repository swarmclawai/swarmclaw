import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '@/lib/server/storage'
import { getFileCategory } from '@/lib/server/mime'

interface UploadFile {
  name: string
  size: number
  modified: number
  category: string
  url: string
}

function listUploadFiles(): UploadFile[] {
  if (!fs.existsSync(UPLOAD_DIR)) return []
  const entries = fs.readdirSync(UPLOAD_DIR)
  const files: UploadFile[] = []
  for (const name of entries) {
    const filePath = path.join(UPLOAD_DIR, name)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      const ext = path.extname(name).toLowerCase()
      files.push({
        name,
        size: stat.size,
        modified: stat.mtimeMs,
        category: getFileCategory(ext),
        url: `/api/uploads/${encodeURIComponent(name)}`,
      })
    } catch {
      // skip files we can't stat
    }
  }
  return files
}

export async function GET() {
  const files = listUploadFiles()
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  return NextResponse.json({ files, totalSize, count: files.length })
}

interface DeleteBody {
  filenames?: string[]
  olderThanDays?: number
  category?: string
  all?: boolean
}

function isUnsafeName(name: string): boolean {
  return name.includes('/') || name.includes('\\') || name.includes('..')
}

export async function DELETE(req: Request) {
  const body = (await req.json()) as DeleteBody
  const files = listUploadFiles()
  let toDelete: string[] = []

  if (body.all) {
    toDelete = files.map((f) => f.name)
  } else if (body.filenames && Array.isArray(body.filenames)) {
    for (const name of body.filenames) {
      if (typeof name !== 'string' || isUnsafeName(name)) {
        return NextResponse.json({ error: `Invalid filename: ${name}` }, { status: 400 })
      }
    }
    toDelete = body.filenames
  } else if (typeof body.olderThanDays === 'number') {
    const cutoff = Date.now() - body.olderThanDays * 86_400_000
    toDelete = files.filter((f) => f.modified < cutoff).map((f) => f.name)
  } else if (typeof body.category === 'string') {
    toDelete = files.filter((f) => f.category === body.category).map((f) => f.name)
  } else {
    return NextResponse.json({ error: 'Provide filenames, olderThanDays, category, or all' }, { status: 400 })
  }

  let deleted = 0
  let freedBytes = 0
  for (const name of toDelete) {
    const filePath = path.join(UPLOAD_DIR, name)
    try {
      const stat = fs.statSync(filePath)
      fs.unlinkSync(filePath)
      freedBytes += stat.size
      deleted++
    } catch {
      // file already gone or inaccessible
    }
  }

  return NextResponse.json({ deleted, freedBytes })
}
