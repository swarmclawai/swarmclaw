import { NextResponse } from 'next/server'
import { addKnowledge, searchKnowledge, listKnowledge } from '@/lib/server/memory-db'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')
  const tagsParam = searchParams.get('tags')
  const limitParam = searchParams.get('limit')

  const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined
  const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10) || 50)) : undefined

  if (q) {
    const results = searchKnowledge(q, tags, limit)
    return NextResponse.json(results)
  }

  const entries = listKnowledge(tags, limit)
  return NextResponse.json(entries)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { title, content, tags } = body as Record<string, unknown>

  if (typeof title !== 'string' || !title.trim()) {
    return NextResponse.json({ error: 'title is required.' }, { status: 400 })
  }
  if (typeof content !== 'string') {
    return NextResponse.json({ error: 'content is required.' }, { status: 400 })
  }

  const normalizedTags = Array.isArray(tags)
    ? (tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined

  const entry = addKnowledge({
    title: title.trim(),
    content,
    tags: normalizedTags,
  })

  return NextResponse.json(entry)
}
