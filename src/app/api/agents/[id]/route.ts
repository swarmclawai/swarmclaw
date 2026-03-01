import { NextResponse } from 'next/server'
import { loadAgents, saveAgents, loadSessions, saveSessions, logActivity } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { mutateItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: () => loadAgents({ includeTrashed: true }), save: saveAgents, topic: 'agents' }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (agent) => {
    Object.assign(agent, body, { updatedAt: Date.now() })
    if (body.apiEndpoint !== undefined) {
      agent.apiEndpoint = normalizeProviderEndpoint(
        body.provider || agent.provider,
        body.apiEndpoint,
      )
    }
    delete (agent as Record<string, unknown>).id
    agent.id = id
    return agent
  })
  if (!result) return notFound()
  logActivity({ entityType: 'agent', entityId: id, action: 'updated', actor: 'user', summary: `Agent updated: "${result.name}"` })
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Soft delete — set trashedAt instead of removing the record
  const result = mutateItem(ops, id, (agent) => {
    agent.trashedAt = Date.now()
    return agent
  })
  if (!result) return notFound()
  logActivity({ entityType: 'agent', entityId: id, action: 'deleted', actor: 'user', summary: `Agent trashed: "${result.name}"` })

  // Detach sessions from the trashed agent
  const sessions = loadSessions()
  let detachedSessions = 0
  for (const session of Object.values(sessions) as Array<Record<string, unknown>>) {
    if (!session || session.agentId !== id) continue
    session.agentId = null
    detachedSessions += 1
  }
  if (detachedSessions > 0) {
    saveSessions(sessions)
  }

  return NextResponse.json({ ok: true, detachedSessions })
}
