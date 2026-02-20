import { NextResponse } from 'next/server'
import { loadDocuments, saveDocuments } from '@/lib/server/storage'

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const docs = loadDocuments()
  const doc = docs[id]
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  return NextResponse.json(doc)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const docs = loadDocuments()
  const doc = docs[id]
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  if (body.title !== undefined) doc.title = body.title
  if (body.fileName !== undefined) doc.fileName = body.fileName
  if (body.sourcePath !== undefined) doc.sourcePath = body.sourcePath
  if (body.content !== undefined) doc.content = body.content
  if (body.method !== undefined) doc.method = body.method
  if (body.metadata !== undefined) doc.metadata = normalizeObject(body.metadata)
  doc.textLength = typeof body.textLength === 'number'
    ? body.textLength
    : String(doc.content || '').length
  doc.updatedAt = Date.now()

  docs[id] = doc
  saveDocuments(docs)
  return NextResponse.json(doc)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const docs = loadDocuments()
  if (!docs[id]) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  delete docs[id]
  saveDocuments(docs)
  return NextResponse.json({ ok: true })
}
