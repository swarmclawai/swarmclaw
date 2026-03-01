import { NextResponse } from 'next/server'
import { ensureGatewayConnected, getGateway, disconnectGateway, manualConnect } from '@/lib/server/openclaw-gateway'

/** POST — proxy an RPC call or perform gateway actions */
export async function POST(req: Request) {
  const body = await req.json()
  const { method, params } = body as { method?: string; params?: Record<string, unknown> }
  if (!method || typeof method !== 'string') {
    return NextResponse.json({ error: 'Missing RPC method' }, { status: 400 })
  }

  // Gateway control actions
  if (method === 'gateway.connect') {
    try {
      const url = (params?.url as string) || undefined
      const token = (params?.token as string) || undefined
      const ok = await manualConnect(url, token)
      return NextResponse.json({ ok })
    } catch (err: unknown) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 })
    }
  }

  if (method === 'gateway.disconnect') {
    disconnectGateway()
    return NextResponse.json({ ok: true })
  }

  // Reload mode get/set
  if (method === 'gateway.reload-mode.get') {
    const gw = await ensureGatewayConnected()
    if (!gw) return NextResponse.json({ error: 'Not connected' }, { status: 503 })
    try {
      const config = await gw.rpc('config.get') as Record<string, unknown> | undefined
      const mode = (config as Record<string, unknown>)?.reloadMode ?? 'hot'
      return NextResponse.json({ ok: true, result: mode })
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
    }
  }

  if (method === 'gateway.reload-mode.set') {
    const gw = await ensureGatewayConnected()
    if (!gw) return NextResponse.json({ error: 'Not connected' }, { status: 503 })
    try {
      await gw.rpc('config.set', { reloadMode: params?.mode })
      return NextResponse.json({ ok: true })
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
    }
  }

  // General RPC proxy
  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  try {
    const result = await gw.rpc(method, params)
    return NextResponse.json({ ok: true, result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** GET — check gateway connection status */
export async function GET() {
  const gw = getGateway()
  return NextResponse.json({ connected: !!gw?.connected })
}
