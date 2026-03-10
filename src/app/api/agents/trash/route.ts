import { NextResponse } from 'next/server'
import { loadTrashedAgents, loadAgents, saveAgents, deleteAgent } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { badRequest, notFound } from '@/lib/server/collection-helpers'
import { purgeAgentReferences, restoreAgentSchedules } from '@/lib/server/agents/agent-cascade'

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

  // Re-enable schedules that were paused when the agent was trashed
  const restoredSchedules = restoreAgentSchedules(id)
  if (restoredSchedules) notify('schedules')

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

  // Hard-delete all referencing entities before removing the agent record
  const purged = purgeAgentReferences(id)
  deleteAgent(id)
  notify('agents')
  if (purged.tasks) notify('tasks')
  if (purged.schedules) notify('schedules')
  if (purged.connectors) notify('connectors')
  if (purged.webhooks) notify('webhooks')
  if (purged.chatrooms) notify('chatrooms')
  return NextResponse.json({ ok: true, ...purged })
}
