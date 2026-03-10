import { NextResponse } from 'next/server'
import { listPendingApprovals, submitDecision } from '@/lib/server/approvals'
import { loadApprovals } from '@/lib/server/storage'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listPendingApprovals('human_loop'))
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
    if (approval.category !== 'human_loop') {
      return NextResponse.json({ error: 'only human-loop approvals are supported here' }, { status: 400 })
    }
    await submitDecision(id, approved)
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 })
  }
}
