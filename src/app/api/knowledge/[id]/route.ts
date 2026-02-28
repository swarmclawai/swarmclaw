import { NextResponse } from 'next/server'
import { getMemoryDb } from '@/lib/server/memory-db'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getMemoryDb()
  const entry = db.get(id)
  if (!entry || entry.category !== 'knowledge') {
    return new NextResponse(null, { status: 404 })
  }
  return NextResponse.json(entry)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getMemoryDb()
  const existing = db.get(id)
  if (!existing || existing.category !== 'knowledge') {
    return new NextResponse(null, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { title, content, tags } = body as Record<string, unknown>

  const updates: Record<string, unknown> = {}
  if (typeof title === 'string' && title.trim()) {
    updates.title = title.trim()
  }
  if (typeof content === 'string') {
    updates.content = content
  }

  const existingMeta = (existing.metadata || {}) as Record<string, unknown>
  if (Array.isArray(tags)) {
    const normalizedTags = (tags as unknown[]).filter(
      (t): t is string => typeof t === 'string' && t.trim().length > 0,
    )
    updates.metadata = { ...existingMeta, tags: normalizedTags }
  }

  const updated = db.update(id, updates)
  if (!updated) {
    return new NextResponse(null, { status: 404 })
  }
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getMemoryDb()
  const existing = db.get(id)
  if (!existing || existing.category !== 'knowledge') {
    return new NextResponse(null, { status: 404 })
  }
  db.delete(id)
  return NextResponse.json({ deleted: id })
}
