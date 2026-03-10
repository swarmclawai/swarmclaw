import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadAgents, upsertTask } from '@/lib/server/storage'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { buildBoardTask } from '@/lib/server/tasks/task-lifecycle'

export async function POST(req: Request) {
  const { agentId, task } = await req.json().catch(() => ({}))
  if (!agentId || !task) {
    return NextResponse.json({ error: 'agentId and task are required' }, { status: 400 })
  }

  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Create a board task and enqueue it
  const taskId = genId()
  const now = Date.now()
  upsertTask(taskId, buildBoardTask({
    id: taskId,
    title: task.slice(0, 80),
    description: task,
    agentId,
    now,
  }))

  // Enqueue — this sets status to queued and kicks the worker
  enqueueTask(taskId)

  return NextResponse.json({ ok: true, taskId })
}
