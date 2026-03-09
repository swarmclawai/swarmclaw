import { NextResponse } from 'next/server'
import { loadTask, patchTask, loadAgents } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { notify } from '@/lib/server/ws-hub'
import { getCheckpointSaver } from '@/lib/server/langgraph-checkpoint'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const approved = body.approved === true

  const task = loadTask(id)
  if (!task) return notFound()
  if (!task.pendingApproval) {
    return NextResponse.json({ error: 'No pending approval on this task' }, { status: 400 })
  }

  const { threadId } = task.pendingApproval

  if (!approved) {
    // Reject: clear approval, delete checkpoint, fail the task
    patchTask(id, (current) => {
      if (!current) return current
      current.pendingApproval = null
      current.status = 'failed'
      current.error = 'Tool execution rejected by user'
      current.updatedAt = Date.now()
      return current
    })
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

  const approvedTask = patchTask(id, (current) => {
    if (!current) return current
    current.pendingApproval = null
    current.updatedAt = Date.now()
    return current
  })
  notify('tasks')

  // Resume in the background
  const sessionId = approvedTask?.sessionId || task.sessionId || ''
  setImmediate(async () => {
    try {
      const { resumeLangGraphOrchestrator } = await import('@/lib/server/orchestrator-lg')
      const result = await resumeLangGraphOrchestrator(agent, sessionId, threadId)
      const updated = patchTask(id, (current) => {
        if (!current || current.pendingApproval) return current
        if (current.status === 'running') current.result = result
        current.updatedAt = Date.now()
        return current
      })
      if (updated) notify('tasks')
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[approve] Resume failed for task ${id}:`, errMsg)
      const updated = patchTask(id, (current) => {
        if (!current) return current
        current.error = errMsg
        current.updatedAt = Date.now()
        return current
      })
      if (updated) notify('tasks')
    }
  })

  return NextResponse.json({ status: 'approved', resuming: true })
}
