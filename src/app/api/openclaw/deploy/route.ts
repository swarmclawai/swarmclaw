import { NextResponse } from 'next/server'
import {
  buildOpenClawDeployBundle,
  deployOpenClawOverSsh,
  getOpenClawLocalDeployStatus,
  getOpenClawRemoteDeployStatus,
  restartOpenClawLocalDeploy,
  runOpenClawRemoteLifecycle,
  startOpenClawLocalDeploy,
  stopOpenClawLocalDeploy,
  verifyOpenClawDeployment,
  type OpenClawExposurePreset,
  type OpenClawRemoteDeployProvider,
  type OpenClawRemoteDeployTemplate,
  type OpenClawSshConfig,
  type OpenClawUseCaseTemplate,
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

function parseIntBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parsePort(value)
  if (typeof parsed !== 'number') return fallback
  return Math.max(min, Math.min(max, parsed))
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

function parseUseCase(value: unknown): OpenClawUseCaseTemplate | undefined {
  if (
    value === 'local-dev'
    || value === 'single-vps'
    || value === 'private-tailnet'
    || value === 'browser-heavy'
    || value === 'team-control'
  ) {
    return value
  }
  return undefined
}

function parseExposure(value: unknown): OpenClawExposurePreset | undefined {
  if (
    value === 'private-lan'
    || value === 'tailscale'
    || value === 'caddy'
    || value === 'nginx'
    || value === 'ssh-tunnel'
  ) {
    return value
  }
  return undefined
}

function parseSsh(value: unknown): Partial<OpenClawSshConfig> | null {
  if (!value || typeof value !== 'object') return null
  const ssh = value as Record<string, unknown>
  return {
    host: typeof ssh.host === 'string' ? ssh.host : '',
    user: typeof ssh.user === 'string' ? ssh.user : null,
    port: parsePort(ssh.port),
    keyPath: typeof ssh.keyPath === 'string' ? ssh.keyPath : null,
    targetDir: typeof ssh.targetDir === 'string' ? ssh.targetDir : null,
  }
}

export async function GET() {
  return NextResponse.json({
    local: getOpenClawLocalDeployStatus(),
    remote: getOpenClawRemoteDeployStatus(),
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

    if (action === 'restart-local') {
      const result = await restartOpenClawLocalDeploy({
        port: parsePort(body.port),
        token: typeof body.token === 'string' ? body.token : null,
      })
      return NextResponse.json({
        ok: true,
        local: result.local,
        token: result.token,
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
        useCase: parseUseCase(body.useCase),
        exposure: parseExposure(body.exposure),
      })
      return NextResponse.json({
        ok: true,
        bundle,
      })
    }

    if (action === 'ssh-deploy') {
      const result = await deployOpenClawOverSsh({
        template: parseTemplate(body.template),
        target: typeof body.target === 'string' ? body.target : null,
        token: typeof body.token === 'string' ? body.token : null,
        scheme: body.scheme === 'http' ? 'http' : 'https',
        port: parsePort(body.port),
        provider: parseProvider(body.provider),
        useCase: parseUseCase(body.useCase),
        exposure: parseExposure(body.exposure),
        ssh: parseSsh(body.ssh),
      })
      return NextResponse.json({
        ok: result.ok,
        remote: getOpenClawRemoteDeployStatus(),
        processId: result.processId || null,
        token: result.token,
        bundle: result.bundle,
        summary: result.summary,
        commandPreview: result.commandPreview,
      })
    }

    if (
      action === 'remote-start'
      || action === 'remote-stop'
      || action === 'remote-restart'
      || action === 'remote-upgrade'
      || action === 'remote-backup'
      || action === 'remote-restore'
      || action === 'remote-rotate-token'
    ) {
      const actionMap = {
        'remote-start': 'start',
        'remote-stop': 'stop',
        'remote-restart': 'restart',
        'remote-upgrade': 'upgrade',
        'remote-backup': 'backup',
        'remote-restore': 'restore',
        'remote-rotate-token': 'rotate-token',
      } as const
      const lifecycleAction = action as keyof typeof actionMap
      const result = await runOpenClawRemoteLifecycle({
        action: actionMap[lifecycleAction],
        ssh: parseSsh(body.ssh),
        token: typeof body.token === 'string' ? body.token : null,
        backupPath: typeof body.backupPath === 'string' ? body.backupPath : null,
      })
      return NextResponse.json({
        ok: result.ok,
        remote: getOpenClawRemoteDeployStatus(),
        processId: result.processId || null,
        token: result.token,
        summary: result.summary,
        commandPreview: result.commandPreview,
      })
    }

    if (action === 'verify') {
      const result = await verifyOpenClawDeployment({
        endpoint: typeof body.endpoint === 'string' ? body.endpoint : null,
        credentialId: typeof body.credentialId === 'string' ? body.credentialId : null,
        token: typeof body.token === 'string' ? body.token : null,
        model: typeof body.model === 'string' ? body.model : null,
        timeoutMs: parseIntBounded(body.timeoutMs, 8000, 1000, 30000),
      })
      return NextResponse.json({
        ok: result.ok,
        verify: result,
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
