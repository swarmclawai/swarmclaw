import { NextResponse } from 'next/server'
import {
  listTrashedAgentsForApi,
  permanentlyDeleteTrashedAgent,
  restoreTrashedAgent,
} from '@/lib/server/agents/agent-service'
import { notify } from '@/lib/server/ws-hub'
import { badRequest, notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'

/** GET — list trashed agents */
export async function GET() {
  return NextResponse.json(listTrashedAgentsForApi())
}

/** POST { id } — restore a trashed agent */
export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const id = body?.id as string | undefined
  if (!id) return badRequest('Missing agent id')

  const agent = restoreTrashedAgent(id)
  if (!agent) return notFound()
  notify('agents')
  return NextResponse.json(agent)
}

/** DELETE { id } — permanently delete a trashed agent */
export async function DELETE(req: Request) {
  const { data: body, error: parseError } = await safeParseBody(req)
  if (parseError) return parseError
  const id = body?.id as string | undefined
  if (!id) return badRequest('Missing agent id')

  const result = permanentlyDeleteTrashedAgent(id)
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound()
    return badRequest('Agent must be trashed before permanent deletion')
  }
  const purged = result.purged
  notify('agents')
  if (purged.tasks) notify('tasks')
  if (purged.schedules) notify('schedules')
  if (purged.connectors) notify('connectors')
  if (purged.webhooks) notify('webhooks')
  if (purged.chatrooms) notify('chatrooms')
  return NextResponse.json({ ok: true, ...purged })
}
