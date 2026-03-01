import { NextResponse } from 'next/server'
import { loadSessions } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()
  return NextResponse.json(sessions[id].messages)
}
