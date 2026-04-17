import { NextResponse } from 'next/server'
import { z } from 'zod'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { formatZodError } from '@/lib/validation/schemas'
import { notFound } from '@/lib/server/collection-helpers'
import {
  getMission,
  patchMission,
  removeMission,
} from '@/lib/server/missions/mission-repository'
import { patchSession } from '@/lib/server/sessions/session-repository'

export const dynamic = 'force-dynamic'

const MissionUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(4000).optional(),
  successCriteria: z.array(z.string().min(1)).max(32).optional(),
  agentIds: z.array(z.string().min(1)).max(32).optional(),
  budget: z.object({
    maxUsd: z.number().positive().nullable().optional(),
    maxTokens: z.number().positive().int().nullable().optional(),
    maxToolCalls: z.number().positive().int().nullable().optional(),
    maxWallclockSec: z.number().positive().int().nullable().optional(),
    maxTurns: z.number().positive().int().nullable().optional(),
    maxParallelBranches: z.number().positive().int().nullable().optional(),
    warnAtFractions: z.array(z.number().positive().lt(1)).max(10).optional(),
  }).partial().optional(),
  reportSchedule: z.object({
    intervalSec: z.number().int().min(30),
    format: z.enum(['markdown', 'slack', 'discord', 'email', 'audio']),
    enabled: z.boolean().default(true),
    lastReportAt: z.number().nullable().optional(),
  }).strict().nullable().optional(),
  reportConnectorIds: z.array(z.string().min(1)).max(8).optional(),
}).strict()

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMission(id)
  if (!mission) return notFound()
  return NextResponse.json(mission)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = MissionUpdateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })
  const updated = patchMission(id, (current) => {
    if (!current) return null
    return {
      ...current,
      ...(parsed.data.title != null ? { title: parsed.data.title } : {}),
      ...(parsed.data.goal != null ? { goal: parsed.data.goal } : {}),
      ...(parsed.data.successCriteria != null ? { successCriteria: parsed.data.successCriteria } : {}),
      ...(parsed.data.agentIds != null ? { agentIds: parsed.data.agentIds } : {}),
      ...(parsed.data.budget != null ? { budget: { ...current.budget, ...parsed.data.budget } } : {}),
      ...(parsed.data.reportSchedule !== undefined ? { reportSchedule: parsed.data.reportSchedule } : {}),
      ...(parsed.data.reportConnectorIds != null ? { reportConnectorIds: parsed.data.reportConnectorIds } : {}),
    }
  })
  if (!updated) return notFound()
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMission(id)
  if (!mission) return notFound()
  removeMission(id)
  try {
    patchSession(mission.rootSessionId, (current) => {
      if (!current) return null
      if (current.missionId !== id) return current
      return { ...current, missionId: null }
    })
  } catch {
    // Session may already be gone.
  }
  return new NextResponse('OK')
}
