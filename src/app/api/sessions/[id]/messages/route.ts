import { NextResponse } from 'next/server'
import { loadSessions } from '@/lib/server/storage'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return new NextResponse(null, { status: 404 })
  return NextResponse.json(sessions[id].messages)
}
