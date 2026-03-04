import { NextResponse } from 'next/server'
import { loadSouls, saveSouls, deleteSoul, logActivity } from '@/lib/server/storage'
import { SOUL_LIBRARY } from '@/lib/soul-library'
import { notify } from '@/lib/server/ws-hub'

export const dynamic = 'force-dynamic'

/** GET /api/souls/[id] */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  
  // Check static library first
  const staticSoul = SOUL_LIBRARY.find(s => s.id === id)
  if (staticSoul) return NextResponse.json(staticSoul)

  const souls = loadSouls()
  if (!souls[id]) return NextResponse.json({ error: 'Soul not found' }, { status: 404 })
  return NextResponse.json(souls[id])
}

/** PUT /api/souls/[id] — update custom soul */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  
  // Can only update custom souls
  const souls = loadSouls()
  if (!souls[id]) {
    return NextResponse.json({ error: 'Only custom souls can be modified via this endpoint' }, { status: 403 })
  }

  const updated = { ...souls[id], ...body, id, updatedAt: Date.now() }
  souls[id] = updated
  saveSouls(souls)
  
  notify('souls')
  return NextResponse.json(updated)
}

/** DELETE /api/souls/[id] — delete custom soul */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  
  // Only allow deleting custom ones
  const souls = loadSouls()
  if (!souls[id]) {
     const isStatic = SOUL_LIBRARY.some(s => s.id === id)
     if (isStatic) return NextResponse.json({ error: 'Cannot delete static library souls' }, { status: 403 })
     return NextResponse.json({ error: 'Soul not found' }, { status: 404 })
  }

  const name = souls[id].name
  deleteSoul(id)
  
  logActivity({ 
    entityType: 'soul', 
    entityId: id, 
    action: 'deleted', 
    actor: 'user', 
    summary: `Custom soul deleted: "${name}"` 
  })
  
  notify('souls')
  return NextResponse.json({ deleted: id })
}
