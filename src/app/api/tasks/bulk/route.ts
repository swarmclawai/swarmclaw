import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { bulkUpdateTasksFromRoute } from '@/lib/server/tasks/task-route-service'

/**
 * Bulk update tasks — batch status changes, agent/project reassignment, or archive/delete.
 *
 * POST body:
 *   ids: string[]                — required, task IDs to update
 *   status?: BoardTaskStatus     — move all to this status
 *   agentId?: string | null      — reassign agent (null to clear)
 *   projectId?: string | null    — reassign project (null to clear)
 */
export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = bulkUpdateTasksFromRoute(body)
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
