import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { restoreKnowledgeSource } from '@/lib/server/knowledge-sources'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await restoreKnowledgeSource(id)
  if (!detail) return notFound()
  return NextResponse.json(detail)
}
