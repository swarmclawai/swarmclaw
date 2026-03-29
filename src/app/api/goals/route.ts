import { NextResponse } from 'next/server'
import { z } from 'zod'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { getAllGoals, createGoal } from '@/lib/server/goals/goal-service'
import { formatZodError } from '@/lib/validation/schemas'
export const dynamic = 'force-dynamic'

const GoalCreateSchema = z.object({
  title: z.string().min(1, 'Goal title is required'),
  description: z.string().optional().default(''),
  level: z.enum(['organization', 'team', 'project', 'agent', 'task']),
  parentGoalId: z.string().nullable().optional().default(null),
  projectId: z.string().nullable().optional().default(null),
  agentId: z.string().nullable().optional().default(null),
  taskId: z.string().nullable().optional().default(null),
  objective: z.string().min(1, 'Objective is required'),
  constraints: z.array(z.string()).optional().default([]),
  successMetric: z.string().nullable().optional().default(null),
  budgetUsd: z.number().positive().nullable().optional().default(null),
  deadlineAt: z.number().nullable().optional().default(null),
})

export async function GET() {
  return NextResponse.json(getAllGoals())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = GoalCreateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })
  return NextResponse.json(createGoal(parsed.data))
}
