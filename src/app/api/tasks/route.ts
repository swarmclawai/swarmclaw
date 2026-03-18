import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { perf } from '@/lib/server/runtime/perf'
import { TaskCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
import {
  createTaskFromRoute,
  deleteTasksByFilter,
  prepareTasksForListing,
} from '@/lib/server/tasks/task-route-service'

export async function GET(req: Request) {
  const endPerf = perf.start('api', 'GET /api/tasks')
  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('includeArchived') === 'true'
  const missionTasks = prepareTasksForListing()

  if (includeArchived) {
    endPerf({ count: Object.keys(missionTasks).length })
    return NextResponse.json(missionTasks)
  }

  // Exclude archived tasks by default
  const filtered: Record<string, (typeof missionTasks)[string]> = {}
  for (const [id, task] of Object.entries(missionTasks)) {
    if (task.status !== 'archived') {
      filtered[id] = task
    }
  }
  endPerf({ count: Object.keys(filtered).length })
  return NextResponse.json(filtered)
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') // 'all' | 'schedule' | 'done' | null
  return NextResponse.json(deleteTasksByFilter(filter))
}

export async function POST(req: Request) {
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = TaskCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const result = createTaskFromRoute({ ...raw, ...parsed.data } as Record<string, unknown>)
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
