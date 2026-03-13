import { NextResponse } from 'next/server'
import { loadAgents, loadSchedules, logActivity, upsertSchedule, upsertSchedules } from '@/lib/server/storage'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { prepareScheduleCreate } from '@/lib/server/schedules/schedule-service'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('includeArchived') === 'true'
  const schedules = loadSchedules()
  if (includeArchived) return NextResponse.json(schedules)

  const filtered: typeof schedules = {}
  for (const [id, schedule] of Object.entries(schedules)) {
    if (schedule.status === 'archived') continue
    filtered[id] = schedule
  }
  return NextResponse.json(filtered)
}

export async function POST(req: Request) {
  const body = await req.json()
  const now = Date.now()
  const schedules = loadSchedules()
  const agents = loadAgents()
  const candidateAgentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
  const agent = agents[candidateAgentId]
  if (!agent) {
    return NextResponse.json({ error: `Agent not found: ${String(body?.agentId)}` }, { status: 400 })
  }
  if (isAgentDisabled(agent)) {
    return NextResponse.json({ error: buildAgentDisabledMessage(agent, 'take scheduled work') }, { status: 409 })
  }
  const prepared = prepareScheduleCreate({
    input: body as Record<string, unknown>,
    schedules,
    now,
    cwd: WORKSPACE_DIR,
  })
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: 400 })
  }
  if (prepared.kind === 'duplicate') {
    if (prepared.entries.length === 1) upsertSchedule(prepared.scheduleId, prepared.schedule)
    else if (prepared.entries.length > 1) upsertSchedules(prepared.entries)
    if (prepared.entries.length > 0) notify('schedules')
    return NextResponse.json(prepared.schedule)
  }

  upsertSchedule(prepared.scheduleId, prepared.schedule)
  logActivity({
    entityType: 'schedule',
    entityId: prepared.scheduleId,
    action: 'created',
    actor: 'user',
    summary: `Schedule created: "${prepared.schedule.name}"`,
  })
  notify('schedules')
  return NextResponse.json(prepared.schedule)
}
