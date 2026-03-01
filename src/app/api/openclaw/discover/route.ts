import { NextResponse } from 'next/server'
import os from 'node:os'
import { probeOpenClawHealth } from '@/lib/server/openclaw-health'
export const dynamic = 'force-dynamic'

const DEFAULT_PORTS = [18789, 18790]
const PROBE_TIMEOUT_MS = 4000

function getLanIps(): string[] {
  const interfaces = os.networkInterfaces()
  const ips: string[] = []
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address)
      }
    }
  }
  return ips
}

export async function GET() {
  try {
    const hosts = ['127.0.0.1', ...getLanIps()]
    const probes: Array<Promise<{
      host: string
      port: number
      healthy: boolean
      models?: string[]
      error?: string
    }>> = []

    for (const host of hosts) {
      for (const port of DEFAULT_PORTS) {
        probes.push(
          probeOpenClawHealth({
            endpoint: `http://${host}:${port}`,
            timeoutMs: PROBE_TIMEOUT_MS,
          }).then((result) => ({
            host,
            port,
            healthy: result.ok,
            models: result.models.length > 0 ? result.models : undefined,
            error: result.error || undefined,
          })).catch(() => ({
            host,
            port,
            healthy: false,
            error: 'unreachable',
          })),
        )
      }
    }

    const results = await Promise.all(probes)
    return NextResponse.json({ gateways: results })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Discovery failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
