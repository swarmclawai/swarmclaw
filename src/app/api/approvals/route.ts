import { NextResponse } from 'next/server'
import { listPendingApprovals, submitDecision } from '@/lib/server/approvals'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listPendingApprovals())
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { id, approved } = body
    if (!id || typeof approved !== 'boolean') {
      return NextResponse.json({ error: 'id and approved required' }, { status: 400 })
    }
    await submitDecision(id, approved)
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 })
  }
}
