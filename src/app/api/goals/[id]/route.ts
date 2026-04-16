import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { getGoalById, updateGoal, deleteGoal, getGoalChain } from '@/lib/server/goals/goal-service'
import { notFound } from '@/lib/server/collection-helpers'
import { GoalUpdateSchema, formatZodError } from '@/lib/validation/schemas'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const goal = getGoalById(id)
  if (!goal) return notFound()
  const chain = getGoalChain(id)
  return NextResponse.json({ ...goal, chain })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = GoalUpdateSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })

  const rawKeys = new Set(Object.keys(raw ?? {}))
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (rawKeys.has(key)) patch[key] = value
  }

  const updated = updateGoal(id, patch)
  if (!updated) return notFound()
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteGoal(id)) return notFound()
  return new NextResponse('OK')
}
