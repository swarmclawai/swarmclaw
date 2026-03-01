import { genId } from '@/lib/id'
import fs from 'fs'
import { NextResponse } from 'next/server'
import { getMemoryDb, getMemoryLookupLimits, storeMemoryImageAsset, storeMemoryImageFromDataUrl } from '@/lib/server/memory-db'
import { resolveLookupRequest } from '@/lib/server/memory-graph'
import type { MemoryReference, FileReference, MemoryImage } from '@/types'

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
    const base = db.search(q, agentId || undefined)
    const entries = base.slice(0, limits.maxPerLookup)
    if (envelope) {
      return NextResponse.json({
        entries,
        truncated: base.length > entries.length,
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
  const body = await parseJsonBody(req)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const db = getMemoryDb()
  const draftId = genId(6)

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
    agentId: typeof body.agentId === 'string' ? body.agentId : null,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    category: typeof body.category === 'string' && body.category.trim() ? body.category : 'note',
    title: typeof body.title === 'string' && body.title.trim() ? body.title : 'Untitled',
    content: typeof body.content === 'string' ? body.content : '',
    metadata: body.metadata as Record<string, unknown> | undefined,
    references: body.references as MemoryReference[] | undefined,
    filePaths: body.filePaths as FileReference[] | undefined,
    image: image as MemoryImage | null | undefined,
    imagePath: image && typeof image === 'object' && 'path' in image ? String((image as { path: string }).path) : null,
    linkedMemoryIds: body.linkedMemoryIds as string[] | undefined,
  })
  return NextResponse.json(entry)
}
