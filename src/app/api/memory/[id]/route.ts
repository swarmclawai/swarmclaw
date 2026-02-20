import crypto from 'crypto'
import fs from 'fs'
import { NextResponse } from 'next/server'
import { getMemoryDb, getMemoryLookupLimits, storeMemoryImageAsset, storeMemoryImageFromDataUrl } from '@/lib/server/memory-db'
import { resolveLookupRequest } from '@/lib/server/memory-graph'

function parseOptionalInt(raw: string | null): number | undefined {
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const envelope = searchParams.get('envelope') === 'true'
  const requestedDepth = parseOptionalInt(searchParams.get('depth'))
  const requestedLimit = parseOptionalInt(searchParams.get('limit'))
  const requestedLinkedLimit = parseOptionalInt(searchParams.get('linkedLimit'))
  const db = getMemoryDb()

  if (requestedDepth == null || requestedDepth <= 0) {
    const entry = db.get(id)
    if (!entry) return new NextResponse(null, { status: 404 })
    return NextResponse.json(entry)
  }

  const defaults = getMemoryLookupLimits()
  const limits = resolveLookupRequest(defaults, {
    depth: requestedDepth,
    limit: requestedLimit,
    linkedLimit: requestedLinkedLimit,
  })
  const result = db.getWithLinked(id, limits.maxDepth, limits.maxPerLookup, limits.maxLinkedExpansion)
  if (!result) return new NextResponse(null, { status: 404 })
  if (envelope) return NextResponse.json(result)
  return NextResponse.json(result.entries)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const db = getMemoryDb()

  let image = body.image
  const inputImagePath = typeof body.imagePath === 'string' ? body.imagePath.trim() : ''
  const inputImageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : ''
  if (inputImageDataUrl) {
    try {
      image = await storeMemoryImageFromDataUrl(inputImageDataUrl, `${id}-${crypto.randomBytes(2).toString('hex')}`)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid image data URL' }, { status: 400 })
    }
  } else if (inputImagePath) {
    if (!fs.existsSync(inputImagePath)) {
      return NextResponse.json({ error: `Image file not found: ${inputImagePath}` }, { status: 400 })
    }
    try {
      image = await storeMemoryImageAsset(inputImagePath, `${id}-${crypto.randomBytes(2).toString('hex')}`)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to store memory image' }, { status: 400 })
    }
  }

  const entry = db.update(id, {
    ...body,
    image,
    imagePath: image?.path || body.imagePath,
  })
  if (!entry) return new NextResponse(null, { status: 404 })
  return NextResponse.json(entry)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getMemoryDb()
  db.delete(id)
  return NextResponse.json('ok')
}
