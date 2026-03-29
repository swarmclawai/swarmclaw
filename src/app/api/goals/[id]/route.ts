import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { getGoalById, updateGoal, deleteGoal, getGoalChain } from '@/lib/server/goals/goal-service'
import { notFound } from '@/lib/server/collection-helpers'
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
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const updated = updateGoal(id, body)
  if (!updated) return notFound()
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteGoal(id)) return notFound()
  return new NextResponse('OK')
}
