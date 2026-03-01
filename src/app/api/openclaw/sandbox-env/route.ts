import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'

/** GET — list available and allowed env keys for sandbox */
export async function GET() {
  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    // Get available keys from dotenv
    const available = await gw.rpc('env.keys') as string[] | undefined

    // Get current config to find allowed keys
    const config = await gw.rpc('config.get') as Record<string, unknown> | undefined
    const agents = (config as Record<string, unknown>)?.agents as Record<string, unknown> | undefined
    const defaults = agents?.defaults as Record<string, unknown> | undefined
    const sandbox = defaults?.sandbox as Record<string, unknown> | undefined
    const docker = sandbox?.docker as Record<string, unknown> | undefined
    const envList = docker?.env as string[] | undefined

    // Parse allowed keys from ${KEY} format
    const allowed = (envList ?? [])
      .map((entry) => {
        const m = entry.match(/^\$\{(.+)\}$/)
        return m ? m[1] : entry
      })

    return NextResponse.json({ available: available ?? [], allowed })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** PUT { allowed: string[] } — update sandbox env allowlist */
export async function PUT(req: Request) {
  const body = await req.json()
  const { allowed } = body as { allowed?: string[] }
  if (!allowed || !Array.isArray(allowed)) {
    return NextResponse.json({ error: 'Missing allowed array' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    // Format as ${KEY} for gateway config
    const envEntries = allowed.map((key) => `\${${key}}`)

    // Fetch current config hash for conflict detection
    const config = await gw.rpc('config.get') as Record<string, unknown> | undefined
    const configHash = (config as Record<string, unknown>)?._hash as string | undefined

    await gw.rpc('config.set', {
      key: 'agents.defaults.sandbox.docker.env',
      value: envEntries,
      baseHash: configHash,
    })

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
