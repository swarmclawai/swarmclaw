import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadSchedules, saveSchedules, loadAgents, loadTasks, saveTasks } from '@/lib/server/storage'
import { enqueueTask } from '@/lib/server/queue'
import { pushMainLoopEventToMainSessions } from '@/lib/server/main-agent-loop'
import { getScheduleSignatureKey } from '@/lib/schedule-dedupe'

type InFlightTask = {
  status?: string
  sourceScheduleKey?: string | null
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedules = loadSchedules()
  const schedule = schedules[id]
  if (!schedule) return new NextResponse(null, { status: 404 })

  const agents = loadAgents()
  const agent = agents[schedule.agentId]
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 400 })

  const tasks = loadTasks()
  const scheduleSignature = getScheduleSignatureKey(schedule)
  if (scheduleSignature) {
    const inFlight = Object.values(tasks as Record<string, InFlightTask>).some((task) =>
      task
      && (task.status === 'queued' || task.status === 'running')
      && task.sourceScheduleKey === scheduleSignature,
    )
    if (inFlight) {
      return NextResponse.json({ ok: true, queued: false, reason: 'in_flight' })
    }
  }

  const now = Date.now()
  const taskId = crypto.randomBytes(4).toString('hex')
  tasks[taskId] = {
    id: taskId,
    title: `[Sched] ${schedule.name}: ${String(schedule.taskPrompt || '').slice(0, 40)}`,
    description: schedule.taskPrompt || '',
    status: 'backlog',
    agentId: schedule.agentId,
    sessionId: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    sourceType: 'schedule',
    sourceScheduleId: schedule.id,
    sourceScheduleName: schedule.name,
    sourceScheduleKey: scheduleSignature || null,
    createdInSessionId: schedule.createdInSessionId || null,
    createdByAgentId: schedule.createdByAgentId || null,
  }
  saveTasks(tasks)
  enqueueTask(taskId)
  pushMainLoopEventToMainSessions({
    type: 'schedule_fired',
    text: `Schedule fired manually: "${schedule.name}" (${schedule.id}) queued task "${tasks[taskId].title}" (${taskId}).`,
  })

  schedule.lastRunAt = now
  saveSchedules(schedules)

  return NextResponse.json({ ok: true, queued: true, taskId })
}
