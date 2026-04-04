import { NextResponse } from 'next/server'
import { z } from 'zod'

import { listPendingApprovals, submitDecision } from '@/lib/server/approvals'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { loadApprovals } from '@/lib/server/storage'
import { errorMessage } from '@/lib/shared-utils'
import type { ApprovalCategory } from '@/types'

export const dynamic = 'force-dynamic'

const ALLOWED_CATEGORIES: ApprovalCategory[] = [
  'human_loop', 'tool_access', 'extension_scaffold', 'extension_install',
  'task_tool', 'connector_sender', 'agent_create', 'budget_change', 'delegation_enable',
]

const ApprovalDecisionSchema = z.object({
  id: z.string().min(1, 'id is required'),
  approved: z.boolean(),
})

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const categoryParam = searchParams.get('category') as ApprovalCategory | null
  const category = categoryParam && ALLOWED_CATEGORIES.includes(categoryParam)
    ? categoryParam
    : undefined
  return NextResponse.json(listPendingApprovals(category))
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req, ApprovalDecisionSchema)
  if (error) return error

  try {
    const approval = loadApprovals()[body.id]
    if (!approval) {
      return NextResponse.json({ error: 'approval not found' }, { status: 404 })
    }
    await submitDecision(body.id, body.approved)
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 })
  }
}
