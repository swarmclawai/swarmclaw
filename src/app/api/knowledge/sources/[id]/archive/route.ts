import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { archiveKnowledgeSource } from '@/lib/server/knowledge-sources'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const detail = await archiveKnowledgeSource(id, {
    reason: typeof body?.reason === 'string' ? body.reason : null,
    duplicateOfSourceId: typeof body?.duplicateOfSourceId === 'string' ? body.duplicateOfSourceId : null,
    supersededBySourceId: typeof body?.supersededBySourceId === 'string' ? body.supersededBySourceId : null,
  })
  if (!detail) return notFound()
  return NextResponse.json(detail)
}
