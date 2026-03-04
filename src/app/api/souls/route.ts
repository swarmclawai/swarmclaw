import { NextResponse } from 'next/server'
import { SOUL_LIBRARY, type SoulTemplate } from '@/lib/soul-library'
import { loadSouls, saveSouls, logActivity } from '@/lib/server/storage'
import { genId } from '@/lib/id'
import { notify } from '@/lib/server/ws-hub'

export const dynamic = 'force-dynamic'

/** GET /api/souls — returns merged list of static library and custom user souls */
export async function GET(req: Request) {
  const customSouls = loadSouls()
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q')?.toLowerCase() || ''
  const archetype = searchParams.get('archetype')

  const merged: SoulTemplate[] = [
    ...SOUL_LIBRARY,
    ...Object.values(customSouls) as SoulTemplate[],
  ]

  let filtered = merged
  if (archetype && archetype !== 'All') {
    filtered = filtered.filter((s) => s.archetype === archetype)
  }
  if (query) {
    filtered = filtered.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query) ||
        s.tags.some((t) => t.toLowerCase().includes(query)) ||
        s.soul.toLowerCase().includes(query),
    )
  }

  return NextResponse.json(filtered)
}

/** POST /api/souls — create a custom soul */
export async function POST(req: Request) {
  const body = await req.json()
  if (!body.name || !body.soul) {
    return NextResponse.json({ error: 'Name and soul content are required' }, { status: 400 })
  }

  const id = body.id || `custom-${genId()}`
  const souls = loadSouls()
  
  const newSoul: SoulTemplate = {
    id,
    name: body.name,
    description: body.description || '',
    soul: body.soul,
    tags: Array.isArray(body.tags) ? body.tags : [],
    archetype: body.archetype || 'Custom',
  }

  souls[id] = newSoul
  saveSouls(souls)
  
  logActivity({ 
    entityType: 'soul', 
    entityId: id, 
    action: 'created', 
    actor: 'user', 
    summary: `Custom soul created: "${newSoul.name}"` 
  })
  
  notify('souls')
  return NextResponse.json(newSoul)
}
