import { NextResponse } from 'next/server'
import { getMemoryDb } from '@/lib/server/memory-db'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const db = getMemoryDb()
  const entry = db.update(id, body)
  if (!entry) return new NextResponse(null, { status: 404 })
  return NextResponse.json(entry)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getMemoryDb()
  db.delete(id)
  return NextResponse.json('ok')
}
