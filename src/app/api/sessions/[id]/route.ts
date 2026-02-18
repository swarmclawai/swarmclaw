import { NextResponse } from 'next/server'
import { loadSessions, saveSessions, active } from '@/lib/server/storage'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const updates = await req.json()
  const sessions = loadSessions()
  if (!sessions[id]) return new NextResponse(null, { status: 404 })
  if (updates.name !== undefined) sessions[id].name = updates.name
  if (updates.cwd !== undefined) sessions[id].cwd = updates.cwd
  saveSessions(sessions)
  return NextResponse.json(sessions[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  const sessions = loadSessions()
  delete sessions[id]
  saveSessions(sessions)
  return new NextResponse('OK')
}
