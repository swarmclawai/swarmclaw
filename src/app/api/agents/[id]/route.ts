import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { trashAgent, updateAgent } from '@/lib/server/agents/agent-service'
import { loadAgent } from '@/lib/server/agents/agent-repository'
import { notify } from '@/lib/server/ws-hub'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const agent = loadAgent(id)
  if (!agent) return notFound()
  return NextResponse.json(agent)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const result = updateAgent(id, body as Record<string, unknown>)
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = trashAgent(id)
  if (!result.ok) return notFound()
  const { detachedSessions, cascade } = result
  if (cascade.tasks) notify('tasks')
  if (cascade.schedules) notify('schedules')
  if (cascade.connectors) notify('connectors')
  if (cascade.webhooks) notify('webhooks')
  if (cascade.chatrooms) notify('chatrooms')

  return NextResponse.json({ ok: true, detachedSessions, ...cascade })
}
