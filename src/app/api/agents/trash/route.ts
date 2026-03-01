import { NextResponse } from 'next/server'
import { loadTrashedAgents, loadAgents, saveAgents, deleteAgent } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { badRequest, notFound } from '@/lib/server/collection-helpers'

/** GET — list trashed agents */
export async function GET() {
  return NextResponse.json(loadTrashedAgents())
}

/** POST { id } — restore a trashed agent */
export async function POST(req: Request) {
  const body = await req.json()
  const id = body?.id as string | undefined
  if (!id) return badRequest('Missing agent id')

  const all = loadAgents({ includeTrashed: true })
  const agent = all[id]
  if (!agent) return notFound()
  if (!agent.trashedAt) return badRequest('Agent is not trashed')

  delete agent.trashedAt
  agent.updatedAt = Date.now()
  all[id] = agent
  saveAgents(all)
  notify('agents')
  return NextResponse.json(agent)
}

/** DELETE { id } — permanently delete a trashed agent */
export async function DELETE(req: Request) {
  const body = await req.json()
  const id = body?.id as string | undefined
  if (!id) return badRequest('Missing agent id')

  const all = loadAgents({ includeTrashed: true })
  const agent = all[id]
  if (!agent) return notFound()
  if (!agent.trashedAt) return badRequest('Agent must be trashed before permanent deletion')

  deleteAgent(id)
  notify('agents')
  return NextResponse.json({ ok: true })
}
