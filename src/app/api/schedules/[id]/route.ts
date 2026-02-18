import { NextResponse } from 'next/server'
import { loadSchedules, saveSchedules } from '@/lib/server/storage'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const schedules = loadSchedules()
  if (!schedules[id]) return new NextResponse(null, { status: 404 })

  const origId = id
  Object.assign(schedules[id], body)
  schedules[id].id = origId
  saveSchedules(schedules)
  return NextResponse.json(schedules[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedules = loadSchedules()
  if (!schedules[id]) return new NextResponse(null, { status: 404 })
  delete schedules[id]
  saveSchedules(schedules)
  return NextResponse.json('ok')
}
