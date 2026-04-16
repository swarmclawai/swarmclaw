import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadDocuments, saveDocuments, upsertDocumentRevision } from '@/lib/server/storage'
import { DocumentUpdateSchema, formatZodError } from '@/lib/validation/schemas'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const docs = loadDocuments()
  const doc = docs[id]
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  return NextResponse.json(doc)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const raw = await req.json().catch(() => null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: 'Invalid or missing request body' }, { status: 400 })
  }
  const parsed = DocumentUpdateSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })

  const rawKeys = new Set(Object.keys(raw))
  const body = parsed.data

  const docs = loadDocuments()
  const doc = docs[id]
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  // Snapshot previous content as a revision before updating
  if (rawKeys.has('content') && body.content !== undefined && body.content !== doc.content) {
    const prevVersion = typeof doc.currentVersion === 'number' ? doc.currentVersion : 0
    const revisionId = crypto.randomBytes(8).toString('hex')
    upsertDocumentRevision(revisionId, {
      id: revisionId,
      documentId: id,
      version: prevVersion,
      content: doc.content,
      createdAt: Date.now(),
      createdBy: body.createdBy ?? null,
    })
    doc.currentVersion = prevVersion + 1
  }

  if (rawKeys.has('title') && body.title !== undefined) doc.title = body.title
  if (rawKeys.has('fileName')) doc.fileName = body.fileName ?? null
  if (rawKeys.has('sourcePath')) doc.sourcePath = body.sourcePath ?? null
  if (rawKeys.has('content') && body.content !== undefined) doc.content = body.content
  if (rawKeys.has('method') && body.method !== undefined) doc.method = body.method
  if (rawKeys.has('metadata') && body.metadata !== undefined) doc.metadata = body.metadata
  doc.textLength = rawKeys.has('textLength') && body.textLength !== undefined
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
