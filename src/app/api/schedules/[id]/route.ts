import { NextResponse } from 'next/server'
import { loadSchedules, saveSchedules, deleteSchedule } from '@/lib/server/storage'
import { resolveScheduleName } from '@/lib/schedule-name'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadSchedules, save: saveSchedules, deleteFn: deleteSchedule, topic: 'schedules' }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (schedule) => {
    Object.assign(schedule, body)
    schedule.id = id
    schedule.name = resolveScheduleName({
      name: schedule.name,
      taskPrompt: schedule.taskPrompt,
    })
    return schedule
  })
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ ok: true })
}
