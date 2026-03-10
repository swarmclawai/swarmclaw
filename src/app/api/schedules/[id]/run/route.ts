import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { loadSchedule, loadAgents, loadTasks, upsertSchedule, upsertTask } from '@/lib/server/storage'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { getScheduleSignatureKey } from '@/lib/schedules/schedule-dedupe'
import { prepareScheduledTaskRun } from '@/lib/server/tasks/task-lifecycle'

type InFlightTask = {
  status?: string
  sourceScheduleKey?: string | null
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedule = loadSchedule(id)
  if (!schedule) return notFound()

  const agents = loadAgents()
  const agent = agents[schedule.agentId]
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 400 })
  if (isAgentDisabled(agent)) {
    return NextResponse.json({ error: buildAgentDisabledMessage(agent, 'run schedules') }, { status: 409 })
  }

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
  schedule.runNumber = (schedule.runNumber || 0) + 1

  const { taskId } = prepareScheduledTaskRun({
    schedule,
    tasks,
    now,
    scheduleSignature,
  })

  upsertTask(taskId, tasks[taskId])
  enqueueTask(taskId)
  pushMainLoopEventToMainSessions({
    type: 'schedule_fired',
    text: `Schedule fired manually: "${schedule.name}" (${schedule.id}) run #${schedule.runNumber} — task ${taskId}`,
  })

  schedule.lastRunAt = now
  upsertSchedule(schedule.id, schedule)

  return NextResponse.json({ ok: true, queued: true, taskId, runNumber: schedule.runNumber })
}
