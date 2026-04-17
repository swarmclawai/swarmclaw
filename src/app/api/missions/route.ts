import { NextResponse } from 'next/server'
import { z } from 'zod'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { formatZodError } from '@/lib/validation/schemas'
import { listMissions } from '@/lib/server/missions/mission-repository'
import { createMission } from '@/lib/server/missions/mission-service'
import { patchSession } from '@/lib/server/sessions/session-repository'

export const dynamic = 'force-dynamic'

const MissionBudgetSchema = z.object({
  maxUsd: z.number().positive().nullable().optional(),
  maxTokens: z.number().positive().int().nullable().optional(),
  maxToolCalls: z.number().positive().int().nullable().optional(),
  maxWallclockSec: z.number().positive().int().nullable().optional(),
  maxTurns: z.number().positive().int().nullable().optional(),
  maxParallelBranches: z.number().positive().int().nullable().optional(),
  warnAtFractions: z.array(z.number().positive().lt(1)).max(10).optional(),
}).strict()

const ReportScheduleSchema = z.object({
  intervalSec: z.number().int().min(30),
  format: z.enum(['markdown', 'slack', 'discord', 'email', 'audio']),
  enabled: z.boolean().default(true),
  lastReportAt: z.number().nullable().optional(),
}).strict()

const MissionCreateSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  goal: z.string().min(1, 'Goal is required').max(4000),
  successCriteria: z.array(z.string().min(1)).max(32).optional(),
  rootSessionId: z.string().min(1, 'rootSessionId is required'),
  agentIds: z.array(z.string().min(1)).max(32).optional(),
  budget: MissionBudgetSchema.optional(),
  reportSchedule: ReportScheduleSchema.nullable().optional(),
  reportConnectorIds: z.array(z.string().min(1)).max(8).optional(),
})

export async function GET() {
  return NextResponse.json(listMissions())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = MissionCreateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })
  const mission = createMission(parsed.data)
  // Wire the session back-reference so enqueue.ts budget hook picks it up fast.
  try {
    patchSession(mission.rootSessionId, (current) => {
      if (!current) return null
      return { ...current, missionId: mission.id }
    })
  } catch {
    // Session may not exist yet, budget hook falls back to the service map.
  }
  return NextResponse.json(mission)
}
