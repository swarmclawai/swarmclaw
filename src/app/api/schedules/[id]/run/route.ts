import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { notFound } from '@/lib/server/collection-helpers'
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
  if (!schedule) return notFound()

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
  schedule.runNumber = (schedule.runNumber || 0) + 1

  // Reuse linked task if it exists and is not in-flight
  let taskId = ''
  const existingTaskId = typeof schedule.linkedTaskId === 'string' ? schedule.linkedTaskId : ''
  const existingTask = existingTaskId ? tasks[existingTaskId] : null

  if (existingTask && existingTask.status !== 'queued' && existingTask.status !== 'running') {
    taskId = existingTaskId
    const prev = existingTask as Record<string, unknown>
    prev.totalRuns = ((prev.totalRuns as number) || 0) + 1
    if (existingTask.status === 'completed') prev.totalCompleted = ((prev.totalCompleted as number) || 0) + 1
    if (existingTask.status === 'failed') prev.totalFailed = ((prev.totalFailed as number) || 0) + 1

    existingTask.status = 'backlog'
    existingTask.title = `[Sched] ${schedule.name} (run #${schedule.runNumber})`
    existingTask.result = null
    existingTask.error = null
    existingTask.sessionId = null
    existingTask.updatedAt = now
    existingTask.queuedAt = null
    existingTask.startedAt = null
    existingTask.completedAt = null
    existingTask.archivedAt = null
    existingTask.attempts = 0
    existingTask.retryScheduledAt = null
    existingTask.deadLetteredAt = null
    existingTask.validation = null
    prev.runNumber = schedule.runNumber
  } else {
    taskId = genId()
    tasks[taskId] = {
      id: taskId,
      title: `[Sched] ${schedule.name} (run #${schedule.runNumber})`,
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
      runNumber: schedule.runNumber,
    }
    schedule.linkedTaskId = taskId
  }

  saveTasks(tasks)
  enqueueTask(taskId)
  pushMainLoopEventToMainSessions({
    type: 'schedule_fired',
    text: `Schedule fired manually: "${schedule.name}" (${schedule.id}) run #${schedule.runNumber} — task ${taskId}`,
  })

  schedule.lastRunAt = now
  saveSchedules(schedules)

  return NextResponse.json({ ok: true, queued: true, taskId, runNumber: schedule.runNumber })
}
