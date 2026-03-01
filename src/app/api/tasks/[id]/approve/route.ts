import { NextResponse } from 'next/server'
import { loadTasks, saveTasks, loadAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { getCheckpointSaver } from '@/lib/server/langgraph-checkpoint'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const approved = body.approved === true

  const tasks = loadTasks()
  const task = tasks[id]
  if (!task) return new NextResponse(null, { status: 404 })
  if (!task.pendingApproval) {
    return NextResponse.json({ error: 'No pending approval on this task' }, { status: 400 })
  }

  const { threadId } = task.pendingApproval

  if (!approved) {
    // Reject: clear approval, delete checkpoint, fail the task
    task.pendingApproval = null
    task.status = 'failed'
    task.error = 'Tool execution rejected by user'
    task.updatedAt = Date.now()
    saveTasks(tasks)
    await getCheckpointSaver().deleteThread(threadId)
    notify('tasks')
    return NextResponse.json({ status: 'rejected' })
  }

  // Approve: clear pendingApproval, resume the graph
  const agents = loadAgents()
  const agent = agents[task.agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 400 })
  }

  task.pendingApproval = null
  task.updatedAt = Date.now()
  saveTasks(tasks)
  notify('tasks')

  // Resume in the background
  const sessionId = task.sessionId || ''
  setImmediate(async () => {
    try {
      const { resumeLangGraphOrchestrator } = await import('@/lib/server/orchestrator-lg')
      const result = await resumeLangGraphOrchestrator(agent, sessionId, threadId)
      const t2 = loadTasks()
      if (t2[id] && !t2[id].pendingApproval) {
        // Only mark completed if not paused again
        if (t2[id].status === 'running') {
          t2[id].result = result
        }
        t2[id].updatedAt = Date.now()
        saveTasks(t2)
        notify('tasks')
      }
    } catch (err: any) {
      console.error(`[approve] Resume failed for task ${id}:`, err.message)
      const t2 = loadTasks()
      if (t2[id]) {
        t2[id].error = err.message || String(err)
        t2[id].updatedAt = Date.now()
        saveTasks(t2)
        notify('tasks')
      }
    }
  })

  return NextResponse.json({ status: 'approved', resuming: true })
}
