import { genId } from '@/lib/id'
import { NextResponse } from 'next/server'
import { loadDocuments, saveDocuments } from '@/lib/server/storage'

function normalizeLimit(raw: string | null, fallback = 10, max = 200): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export async function GET(req: Request) {
  const docs = loadDocuments()
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().toLowerCase()

  if (!q) {
    return NextResponse.json(docs)
  }

  const terms = q.split(/\s+/).filter(Boolean)
  const limit = normalizeLimit(searchParams.get('limit'), 10, 100)
  const rows = Object.values(docs)
    .map((doc: any) => {
      const title = String(doc.title || '')
      const content = String(doc.content || '')
      const hay = `${title}\n${content}`.toLowerCase()
      if (!terms.every((term) => hay.includes(term))) return null

      let score = hay.includes(q) ? 10 : 0
      for (const term of terms) {
        let idx = hay.indexOf(term)
        while (idx !== -1) {
          score += 1
          idx = hay.indexOf(term, idx + term.length)
        }
      }

      const first = terms[0] || q
      const at = hay.indexOf(first)
      const snippetStart = at >= 0 ? Math.max(0, at - 120) : 0
      const snippetEnd = Math.min(content.length, snippetStart + 320)
      const snippet = content.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim()

      return {
        id: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        sourcePath: doc.sourcePath,
        textLength: doc.textLength || content.length,
        updatedAt: doc.updatedAt,
        score,
        snippet,
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit)

  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const now = Date.now()
  const docs = loadDocuments()
  const id = body.id || genId(6)
  const fileName = body.fileName || body.filename || ''
  const title = body.title || fileName || 'Untitled Document'
  const content = typeof body.content === 'string' ? body.content : ''
  const metadata = normalizeObject(body.metadata)

  docs[id] = {
    id,
    title,
    fileName,
    sourcePath: body.sourcePath || body.path || '',
    method: body.method || 'manual',
    textLength: body.textLength || content.length,
    content,
    metadata,
    createdAt: body.createdAt || now,
    updatedAt: now,
  }

  saveDocuments(docs)
  return NextResponse.json(docs[id])
}
