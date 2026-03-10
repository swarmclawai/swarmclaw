import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw/gateway'
import { errorMessage } from '@/lib/shared-utils'

/** GET — list env var keys from gateway .env */
export async function GET() {
  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  try {
    const result = await gw.rpc('env.keys') as string[] | undefined
    return NextResponse.json(result ?? [])
  } catch (err: unknown) {
    const message = errorMessage(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
