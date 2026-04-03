import { NextResponse } from 'next/server'
import {
  createKnowledgeSource,
  listKnowledgeSourceSummaries,
  searchKnowledgeHits,
} from '@/lib/server/knowledge-sources'
import type { KnowledgeSourceKind } from '@/types'

function parseTags(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const tags = raw.split(',').map((tag) => tag.trim()).filter(Boolean)
  return tags.length > 0 ? tags : undefined
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined
  return Math.max(1, Math.min(500, Number.parseInt(raw, 10) || 50))
}

function parseBool(raw: string | null): boolean {
  if (!raw) return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function inferKind(body: Record<string, unknown>): KnowledgeSourceKind {
  if (body.kind === 'file' || body.kind === 'url' || body.kind === 'manual') return body.kind
  if (typeof body.sourcePath === 'string' && body.sourcePath.trim()) return 'file'
  if (typeof body.sourceUrl === 'string' && body.sourceUrl.trim() && typeof body.content !== 'string') return 'url'
  return 'manual'
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q')
  const tags = parseTags(searchParams.get('tags'))
  const limit = parseLimit(searchParams.get('limit'))
  const includeArchived = parseBool(searchParams.get('includeArchived'))

  if (query && query.trim()) {
    const hits = await searchKnowledgeHits({ query, tags, limit, includeArchived })
    return NextResponse.json(hits)
  }

  const sources = await listKnowledgeSourceSummaries({ tags, limit, includeArchived })
  return NextResponse.json(sources)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const payload = body as Record<string, unknown>

  try {
    const detail = await createKnowledgeSource({
      kind: inferKind(payload),
      title: typeof payload.title === 'string' ? payload.title : undefined,
      content: typeof payload.content === 'string' ? payload.content : undefined,
      tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
      scope: payload.scope === 'agent' ? 'agent' : 'global',
      agentIds: Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string') : undefined,
      sourceLabel: typeof payload.sourceLabel === 'string'
        ? payload.sourceLabel
        : typeof payload.source === 'string'
          ? payload.source
          : undefined,
      sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : undefined,
      sourcePath: typeof payload.sourcePath === 'string'
        ? payload.sourcePath
        : typeof payload.filePath === 'string'
          ? payload.filePath
          : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : undefined,
    })

    return NextResponse.json(detail)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create knowledge source.' },
      { status: 400 },
    )
  }
}
