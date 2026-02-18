import { NextResponse } from 'next/server'
import { loadSchedules, saveSchedules, loadAgents } from '@/lib/server/storage'
import { runOrchestrator } from '@/lib/server/orchestrator'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedules = loadSchedules()
  const schedule = schedules[id]
  if (!schedule) return new NextResponse(null, { status: 404 })

  const agents = loadAgents()
  const agent = agents[schedule.agentId]
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 400 })

  // Fire and forget the orchestrator run
  runOrchestrator(agent, schedule.taskPrompt).catch((err) => {
    console.error(`[schedule/${id}] orchestrator run failed:`, err)
    schedules[id].status = 'failed'
    saveSchedules(schedules)
  })

  schedule.lastRunAt = Date.now()
  saveSchedules(schedules)

  return NextResponse.json({ ok: true })
}
