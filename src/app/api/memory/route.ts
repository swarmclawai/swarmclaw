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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')
  const agentId = searchParams.get('agentId')
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

  if (q) {
    if (limits.maxDepth > 0) {
      const result = db.searchWithLinked(q, agentId || undefined, limits.maxDepth, limits.maxPerLookup, limits.maxLinkedExpansion)
      if (envelope) return NextResponse.json(result)
      return NextResponse.json(result.entries)
    }
    const entries = db.search(q, agentId || undefined).slice(0, limits.maxPerLookup)
    if (envelope) {
      return NextResponse.json({
        entries,
        truncated: db.search(q, agentId || undefined).length > entries.length,
        expandedLinkedCount: 0,
        limits,
      })
    }
    return NextResponse.json(entries)
  }

  const entries = db.list(agentId || undefined, limits.maxPerLookup)
  if (envelope) {
    return NextResponse.json({
      entries,
      truncated: false,
      expandedLinkedCount: 0,
      limits,
    })
  }
  return NextResponse.json(entries)
}

export async function POST(req: Request) {
  const body = await req.json()
  const db = getMemoryDb()
  const draftId = crypto.randomBytes(6).toString('hex')

  let image = body.image
  const inputImagePath = typeof body.imagePath === 'string' ? body.imagePath.trim() : ''
  const inputImageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : ''
  if (inputImageDataUrl) {
    try {
      image = await storeMemoryImageFromDataUrl(inputImageDataUrl, draftId)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid image data URL' }, { status: 400 })
    }
  } else if (inputImagePath) {
    if (!fs.existsSync(inputImagePath)) {
      return NextResponse.json({ error: `Image file not found: ${inputImagePath}` }, { status: 400 })
    }
    try {
      image = await storeMemoryImageAsset(inputImagePath, draftId)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to store memory image' }, { status: 400 })
    }
  }

  const entry = db.add({
    agentId: body.agentId || null,
    sessionId: body.sessionId || null,
    category: body.category || 'note',
    title: body.title || 'Untitled',
    content: body.content || '',
    metadata: body.metadata,
    references: body.references,
    filePaths: body.filePaths,
    image,
    imagePath: image?.path || body.imagePath || null,
    linkedMemoryIds: body.linkedMemoryIds,
  })
  return NextResponse.json(entry)
}
