import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadTasks, saveTasks } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(loadTasks())
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = crypto.randomBytes(4).toString('hex')
  const now = Date.now()
  const tasks = loadTasks()
  tasks[id] = {
    id,
    title: body.title || 'Untitled Task',
    description: body.description || '',
    status: body.status || 'backlog',
    agentId: body.agentId || '',
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
  return NextResponse.json(tasks[id])
}
