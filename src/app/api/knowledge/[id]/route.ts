import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import {
  deleteKnowledgeSource,
  getKnowledgeSourceDetail,
  updateKnowledgeSource,
} from '@/lib/server/knowledge-sources'
import type { KnowledgeSourceKind } from '@/types'

function inferKind(body: Record<string, unknown>): KnowledgeSourceKind | undefined {
  if (body.kind === 'file' || body.kind === 'url' || body.kind === 'manual') return body.kind
  if (typeof body.sourcePath === 'string' && body.sourcePath.trim()) return 'file'
  if (typeof body.sourceUrl === 'string' && body.sourceUrl.trim() && typeof body.content !== 'string') return 'url'
  return undefined
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getKnowledgeSourceDetail(id)
  if (!detail) return notFound()
  return NextResponse.json(detail)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const payload = body as Record<string, unknown>

  try {
    const detail = await updateKnowledgeSource(id, {
      kind: inferKind(payload),
      title: typeof payload.title === 'string' ? payload.title : undefined,
      content: typeof payload.content === 'string' ? payload.content : undefined,
      tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
      scope: payload.scope === 'agent' ? 'agent' : payload.scope === 'global' ? 'global' : undefined,
      agentIds: Array.isArray(payload.agentIds) ? payload.agentIds.filter((agentId): agentId is string => typeof agentId === 'string') : undefined,
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

    if (!detail) return notFound()
    return NextResponse.json(detail)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update knowledge source.' },
      { status: 400 },
    )
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const deleted = await deleteKnowledgeSource(id)
  if (!deleted) return notFound()
  return NextResponse.json({ deleted: id })
}
