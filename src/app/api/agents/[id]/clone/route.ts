import { NextResponse } from 'next/server'
import { loadAgents, saveAgents, logActivity } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const agents = loadAgents({ includeTrashed: true })
  const source = agents[id]
  if (!source) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const newId = crypto.randomUUID()
  const now = Date.now()

  // Deep-copy the source agent, then override clone-specific fields
  const cloned = JSON.parse(JSON.stringify(source)) as typeof source
  cloned.id = newId
  cloned.name = `${source.name} (Copy)`
  cloned.createdAt = now
  cloned.updatedAt = now
  cloned.totalCost = 0
  cloned.lastUsedAt = undefined
  cloned.threadSessionId = null
  cloned.pinned = false
  cloned.trashedAt = undefined

  agents[newId] = cloned
  saveAgents(agents)
  logActivity({
    entityType: 'agent',
    entityId: newId,
    action: 'created',
    actor: 'user',
    summary: `Agent cloned from "${source.name}": "${cloned.name}"`,
  })
  notify('agents')

  return NextResponse.json(cloned)
}
