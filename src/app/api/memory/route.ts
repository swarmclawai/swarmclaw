import { NextResponse } from 'next/server'
import { getMemoryDb } from '@/lib/server/memory-db'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')
  const agentId = searchParams.get('agentId')
  const db = getMemoryDb()

  if (q) {
    return NextResponse.json(db.search(q, agentId || undefined))
  }
  return NextResponse.json(db.list(agentId || undefined))
}

export async function POST(req: Request) {
  const body = await req.json()
  const db = getMemoryDb()
  const entry = db.add({
    agentId: body.agentId || null,
    sessionId: body.sessionId || null,
    category: body.category || 'note',
    title: body.title || 'Untitled',
    content: body.content || '',
    metadata: body.metadata,
  })
  return NextResponse.json(entry)
}
