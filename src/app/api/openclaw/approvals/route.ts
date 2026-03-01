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

/* ── Conflict-detection: track recently resolved approval IDs in-process ── */
const resolvedKey = '__swarmclaw_resolved_approvals__'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolved: Map<string, number> = (globalThis as any)[resolvedKey] ?? ((globalThis as any)[resolvedKey] = new Map<string, number>())
const RESOLVED_TTL_MS = 5 * 60 * 1000

function pruneResolved() {
  const cutoff = Date.now() - RESOLVED_TTL_MS
  for (const [k, ts] of resolved) {
    if (ts < cutoff) resolved.delete(k)
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

  // Conflict detection — prevent duplicate resolution
  pruneResolved()
  if (resolved.has(id)) {
    return NextResponse.json({ error: 'Already resolved' }, { status: 409 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  try {
    await gw.rpc('exec.approvals.resolve', { id, decision })
    resolved.set(id, Date.now())
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
