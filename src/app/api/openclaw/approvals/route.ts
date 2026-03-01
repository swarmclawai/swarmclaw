import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'
import type { PendingExecApproval, ExecApprovalDecision } from '@/types'

/** GET — fetch pending execution approvals from gateway */
export async function GET() {
  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json([], { status: 200 })
  }

  try {
    const result = await gw.rpc('exec.approvals.get') as PendingExecApproval[] | undefined
    return NextResponse.json(result ?? [])
  } catch {
    return NextResponse.json([])
  }
}

/** POST { id, decision } — resolve an execution approval */
export async function POST(req: Request) {
  const body = await req.json()
  const { id, decision } = body as { id?: string; decision?: ExecApprovalDecision }

  if (!id || !decision) {
    return NextResponse.json({ error: 'Missing id or decision' }, { status: 400 })
  }

  const validDecisions: ExecApprovalDecision[] = ['allow-once', 'allow-always', 'deny']
  if (!validDecisions.includes(decision)) {
    return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  try {
    await gw.rpc('exec.approvals.resolve', { id, decision })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
