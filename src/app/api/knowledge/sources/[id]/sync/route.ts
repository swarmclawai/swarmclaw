import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { syncKnowledgeSource } from '@/lib/server/knowledge-sources'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const detail = await syncKnowledgeSource(id)
    if (!detail) return notFound()
    return NextResponse.json(detail)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync knowledge source.' },
      { status: 400 },
    )
  }
}
