import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadAgents, loadTasks, saveTasks } from '@/lib/server/storage'
import { enqueueTask } from '@/lib/server/queue'

export async function POST(req: Request) {
  const { agentId, task } = await req.json()
  if (!agentId || !task) {
    return NextResponse.json({ error: 'agentId and task are required' }, { status: 400 })
  }

  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Create a board task and enqueue it
  const taskId = crypto.randomBytes(4).toString('hex')
  const now = Date.now()
  const tasks = loadTasks()
  tasks[taskId] = {
    id: taskId,
    title: task.slice(0, 80),
    description: task,
    status: 'backlog',
    agentId,
    sessionId: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
  }
  saveTasks(tasks)

  // Enqueue — this sets status to queued and kicks the worker
  enqueueTask(taskId)

  return NextResponse.json({ ok: true, taskId })
}
