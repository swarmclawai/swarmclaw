import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadSchedules, saveSchedules } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(loadSchedules())
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = crypto.randomBytes(4).toString('hex')
  const now = Date.now()
  const schedules = loadSchedules()

  let nextRunAt: number | undefined
  if (body.scheduleType === 'once' && body.runAt) {
    nextRunAt = body.runAt
  } else if (body.scheduleType === 'interval' && body.intervalMs) {
    nextRunAt = now + body.intervalMs
  } else if (body.scheduleType === 'cron') {
    // nextRunAt will be computed by the scheduler engine
    nextRunAt = undefined
  }

  schedules[id] = {
    id,
    name: body.name || 'Unnamed Schedule',
    agentId: body.agentId,
    taskPrompt: body.taskPrompt || '',
    scheduleType: body.scheduleType || 'cron',
    cron: body.cron,
    intervalMs: body.intervalMs,
    runAt: body.runAt,
    lastRunAt: undefined,
    nextRunAt,
    status: body.status || 'active',
    createdAt: now,
  }
  saveSchedules(schedules)
  return NextResponse.json(schedules[id])
}
