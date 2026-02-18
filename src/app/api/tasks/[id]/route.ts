import { NextResponse } from 'next/server'
import { loadTasks, saveTasks } from '@/lib/server/storage'
import { enqueueTask } from '@/lib/server/queue'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tasks = loadTasks()
  if (!tasks[id]) return new NextResponse(null, { status: 404 })
  return NextResponse.json(tasks[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const tasks = loadTasks()
  if (!tasks[id]) return new NextResponse(null, { status: 404 })

  const prevStatus = tasks[id].status

  // Support atomic comment append to avoid race conditions
  if (body.appendComment) {
    if (!tasks[id].comments) tasks[id].comments = []
    tasks[id].comments.push(body.appendComment)
    tasks[id].updatedAt = Date.now()
  } else {
    Object.assign(tasks[id], body, { updatedAt: Date.now() })
  }
  tasks[id].id = id // prevent id overwrite
  saveTasks(tasks)

  // If status changed to 'queued', enqueue it
  if (prevStatus !== 'queued' && tasks[id].status === 'queued') {
    enqueueTask(id)
  }

  return NextResponse.json(tasks[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tasks = loadTasks()
  if (!tasks[id]) return new NextResponse(null, { status: 404 })
  delete tasks[id]
  saveTasks(tasks)
  return NextResponse.json('ok')
}
