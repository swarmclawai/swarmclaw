import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { supersedeKnowledgeSource } from '@/lib/server/knowledge-sources'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  const supersededBySourceId = typeof body === 'object' && body && !Array.isArray(body) && typeof body.supersededBySourceId === 'string'
    ? body.supersededBySourceId
    : ''

  if (!supersededBySourceId.trim()) {
    return NextResponse.json({ error: 'supersededBySourceId is required.' }, { status: 400 })
  }

  try {
    const detail = await supersedeKnowledgeSource(id, supersededBySourceId)
    if (!detail) return notFound()
    return NextResponse.json(detail)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to supersede knowledge source.' },
      { status: 400 },
    )
  }
}
