import { NextResponse } from 'next/server'
import { listPendingApprovals, submitDecision } from '@/lib/server/approvals'
import { loadApprovals } from '@/lib/server/storage'
import { errorMessage } from '@/lib/shared-utils'
import type { ApprovalCategory } from '@/types'

export const dynamic = 'force-dynamic'

const ALLOWED_CATEGORIES: ApprovalCategory[] = [
  'human_loop', 'tool_access', 'extension_scaffold', 'extension_install',
  'task_tool', 'connector_sender', 'agent_create', 'budget_change', 'delegation_enable',
]

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const categoryParam = searchParams.get('category') as ApprovalCategory | null
  const category = categoryParam && ALLOWED_CATEGORIES.includes(categoryParam)
    ? categoryParam
    : undefined
  return NextResponse.json(listPendingApprovals(category))
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { id, approved } = body
    if (!id || typeof approved !== 'boolean') {
      return NextResponse.json({ error: 'id and approved required' }, { status: 400 })
    }
    const approval = loadApprovals()[id]
    if (!approval) {
      return NextResponse.json({ error: 'approval not found' }, { status: 404 })
    }
    await submitDecision(id, approved)
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 })
  }
}
