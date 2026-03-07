import { NextResponse } from 'next/server'
import {
  buildOpenClawDeployBundle,
  getOpenClawLocalDeployStatus,
  startOpenClawLocalDeploy,
  stopOpenClawLocalDeploy,
  type OpenClawRemoteDeployProvider,
  type OpenClawRemoteDeployTemplate,
} from '@/lib/server/openclaw-deploy'

export const dynamic = 'force-dynamic'

function parsePort(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseTemplate(value: unknown): OpenClawRemoteDeployTemplate | undefined {
  if (value === 'docker' || value === 'render' || value === 'fly' || value === 'railway') {
    return value
  }
  return undefined
}

function parseProvider(value: unknown): OpenClawRemoteDeployProvider | undefined {
  if (
    value === 'hetzner'
    || value === 'digitalocean'
    || value === 'vultr'
    || value === 'linode'
    || value === 'lightsail'
    || value === 'gcp'
    || value === 'azure'
    || value === 'oci'
    || value === 'generic'
  ) {
    return value
  }
  return undefined
}

export async function GET() {
  return NextResponse.json({
    local: getOpenClawLocalDeployStatus(),
  })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action : ''

  try {
    if (action === 'start-local') {
      const result = await startOpenClawLocalDeploy({
        port: parsePort(body.port),
        token: typeof body.token === 'string' ? body.token : null,
      })
      return NextResponse.json({
        ok: true,
        local: result.local,
        token: result.token,
      })
    }

    if (action === 'stop-local') {
      return NextResponse.json({
        ok: true,
        local: stopOpenClawLocalDeploy(),
      })
    }

    if (action === 'bundle') {
      const bundle = buildOpenClawDeployBundle({
        template: parseTemplate(body.template),
        target: typeof body.target === 'string' ? body.target : null,
        token: typeof body.token === 'string' ? body.token : null,
        scheme: body.scheme === 'http' ? 'http' : 'https',
        port: parsePort(body.port),
        provider: parseProvider(body.provider),
      })
      return NextResponse.json({
        ok: true,
        bundle,
      })
    }

    return NextResponse.json({ ok: false, error: 'Unknown deploy action.' }, { status: 400 })
  } catch (err: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'OpenClaw deploy action failed.',
      },
      { status: 500 },
    )
  }
}
