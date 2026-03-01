import { NextResponse } from 'next/server'
import { loadSchedules, saveSchedules, deleteSchedule } from '@/lib/server/storage'
import { resolveScheduleName } from '@/lib/schedule-name'
import { notify } from '@/lib/server/ws-hub'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const schedules = loadSchedules()
  if (!schedules[id]) return new NextResponse(null, { status: 404 })

  const origId = id
  Object.assign(schedules[id], body)
  schedules[id].id = origId
  schedules[id].name = resolveScheduleName({
    name: schedules[id].name,
    taskPrompt: schedules[id].taskPrompt,
  })
  saveSchedules(schedules)
  notify('schedules')
  return NextResponse.json(schedules[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedules = loadSchedules()
  if (!schedules[id]) return new NextResponse(null, { status: 404 })
  deleteSchedule(id)
  notify('schedules')
  return NextResponse.json('ok')
}
