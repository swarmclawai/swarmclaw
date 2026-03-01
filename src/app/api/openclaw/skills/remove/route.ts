import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'

/** POST { skillKey, source } — remove a skill via gateway */
export async function POST(req: Request) {
  const body = await req.json()
  const { skillKey, source } = body as { skillKey?: string; source?: string }
  if (!skillKey) {
    return NextResponse.json({ error: 'Missing skillKey' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    await gw.rpc('skills.remove', { skillKey, source })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
