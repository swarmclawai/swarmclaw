import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'

/** POST { name, installId, timeoutMs? } — install a skill via gateway */
export async function POST(req: Request) {
  const body = await req.json()
  const { name, installId, timeoutMs } = body as {
    name?: string
    installId?: string
    timeoutMs?: number
  }
  if (!name) {
    return NextResponse.json({ error: 'Missing skill name' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    const result = await gw.rpc('skills.install', {
      name,
      installId,
      timeoutMs: timeoutMs ?? 120_000,
    }, (timeoutMs ?? 120_000) + 5_000)
    return NextResponse.json({ ok: true, result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
