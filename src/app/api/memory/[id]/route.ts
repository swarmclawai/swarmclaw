import { genId } from '@/lib/id'
import fs from 'fs'
import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { getMemoryDb, getMemoryLookupLimits, storeMemoryImageAsset, storeMemoryImageFromDataUrl } from '@/lib/server/memory-db'
import { resolveLookupRequest } from '@/lib/server/memory-graph'
import type { MemoryImage } from '@/types'

function parseOptionalInt(raw: string | null): number | undefined {
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

function parseTargetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const envelope = searchParams.get('envelope') === 'true'
  const requestedDepth = parseOptionalInt(searchParams.get('depth'))
  const requestedLimit = parseOptionalInt(searchParams.get('limit'))
  const requestedLinkedLimit = parseOptionalInt(searchParams.get('linkedLimit'))
  const db = getMemoryDb()
  const defaults = getMemoryLookupLimits()
  const limits = resolveLookupRequest(defaults, {
    depth: requestedDepth,
    limit: requestedLimit,
    linkedLimit: requestedLinkedLimit,
  })

  if (limits.maxDepth <= 0) {
    const entry = db.get(id)
    if (!entry) return notFound()
    if (envelope) {
      return NextResponse.json({
        entries: [entry],
        truncated: false,
        expandedLinkedCount: 0,
        limits,
      })
    }
    return NextResponse.json(entry)
  }

  const result = db.getWithLinked(id, limits.maxDepth, limits.maxPerLookup, limits.maxLinkedExpansion)
  if (!result) return notFound()
  if (envelope) return NextResponse.json(result)
  return NextResponse.json(result.entries)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseJsonBody(req)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const db = getMemoryDb()
  const linkAction = typeof body.linkAction === 'string' ? body.linkAction.trim().toLowerCase() : ''

  if (linkAction === 'link' || linkAction === 'unlink') {
    const targetIds = parseTargetIds(body.targetIds)
    if (!targetIds.length) {
      return NextResponse.json({ error: 'targetIds is required for linkAction.' }, { status: 400 })
    }
    const updated = linkAction === 'link'
      ? db.link(id, targetIds, true)
      : db.unlink(id, targetIds, true)
    if (!updated) return notFound()
    return NextResponse.json(updated)
  }

  let image = body.image
  const inputImagePath = typeof body.imagePath === 'string' ? body.imagePath.trim() : ''
  const inputImageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : ''
  const clearImage = body.clearImage === true || body.image === null
  if (clearImage) {
    image = null
  } else if (inputImageDataUrl) {
    try {
      image = await storeMemoryImageFromDataUrl(inputImageDataUrl, `${id}-${genId(2)}`)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid image data URL' }, { status: 400 })
    }
  } else if (inputImagePath) {
    if (!fs.existsSync(inputImagePath)) {
      return NextResponse.json({ error: `Image file not found: ${inputImagePath}` }, { status: 400 })
    }
    try {
      image = await storeMemoryImageAsset(inputImagePath, `${id}-${genId(2)}`)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to store memory image' }, { status: 400 })
    }
  }

  const entry = db.update(id, {
    ...body,
    image: image as MemoryImage | null | undefined,
    imagePath: clearImage
      ? null
      : image && typeof image === 'object' && 'path' in image
        ? String((image as { path: string }).path)
        : (typeof body.imagePath === 'string' ? body.imagePath : undefined),
  })
  if (!entry) return notFound()
  return NextResponse.json(entry)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getMemoryDb()
  db.delete(id)
  return NextResponse.json({ ok: true })
}
