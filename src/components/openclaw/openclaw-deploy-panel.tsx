'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api-client'
import { copyTextToClipboard } from '@/lib/clipboard'

type RemoteTemplate = 'docker' | 'render' | 'fly' | 'railway'
type RemoteProvider = 'hetzner' | 'digitalocean' | 'vultr' | 'linode' | 'lightsail' | 'gcp' | 'azure' | 'oci' | 'generic'
type UseCaseTemplate = 'local-dev' | 'single-vps' | 'private-tailnet' | 'browser-heavy' | 'team-control'
type ExposurePreset = 'private-lan' | 'tailscale' | 'caddy' | 'nginx' | 'ssh-tunnel'

interface LocalDeployStatus {
  running: boolean
  processId: string | null
  pid: number | null
  port: number
  endpoint: string
  wsUrl: string
  token: string | null
  startedAt: number | null
  tail: string
  lastError: string | null
  launchCommand: string
  installCommand: string
}

interface RemoteDeployStatus {
  active: boolean
  processId: string | null
  pid: number | null
  action: string | null
  target: string | null
  startedAt: number | null
  status: 'idle' | 'running' | 'exited' | 'killed' | 'failed' | 'timeout'
  exitCode: number | null
  tail: string
  lastError: string | null
  lastSummary: string | null
  lastCommandPreview: string | null
  lastBackupPath: string | null
}

interface DeployFile {
  name: string
  language: 'bash' | 'yaml' | 'env' | 'toml' | 'text'
  content: string
}

interface DeployBundle {
  template: RemoteTemplate
  provider: RemoteProvider
  providerLabel: string
  useCase: UseCaseTemplate
  exposure: ExposurePreset
  title: string
  summary: string
  endpoint: string
  wsUrl: string
  token: string
  runbook: string[]
  files: DeployFile[]
}

interface DeployStatusResponse {
  local: LocalDeployStatus
  remote?: RemoteDeployStatus
}

interface DeployActionResponse {
  ok: boolean
  local?: LocalDeployStatus
  token?: string
  bundle?: DeployBundle
  processId?: string | null
  remote?: RemoteDeployStatus
  summary?: string
  commandPreview?: string
  verify?: {
    ok: boolean
    endpoint: string
    wsUrl: string
    authProvided: boolean
    models: string[]
    error?: string
    hint?: string
  }
  error?: string
}

interface ApplyPatch {
  endpoint?: string
  token?: string
  name?: string
  notes?: string
  deployment?: {
    method?: 'local' | 'bundle' | 'ssh' | 'imported' | null
    provider?: string | null
    remoteTarget?: RemoteTemplate | null
    useCase?: UseCaseTemplate | null
    exposure?: ExposurePreset | null
    sshHost?: string | null
    sshUser?: string | null
    sshPort?: number | null
    sshKeyPath?: string | null
    sshTargetDir?: string | null
    lastDeployAt?: number | null
    lastDeployAction?: string | null
    lastDeploySummary?: string | null
    lastDeployProcessId?: string | null
    lastVerifiedAt?: number | null
    lastVerifiedOk?: boolean | null
    lastVerifiedMessage?: string | null
    lastBackupPath?: string | null
  }
}

interface OpenClawDeployPanelProps {
  endpoint?: string | null
  token?: string | null
  deployment?: ApplyPatch['deployment'] | null
  suggestedName?: string | null
  title?: string
  description?: string
  compact?: boolean
  onApply?: (patch: ApplyPatch) => void | Promise<void>
}

const TEMPLATE_OPTIONS: Array<{
  id: RemoteTemplate
  label: string
  detail: string
}> = [
  {
    id: 'docker',
    label: 'VPS Smart Deploy',
    detail: 'Official OpenClaw Docker image plus cloud-init for mainstream VPS hosts',
  },
  {
    id: 'render',
    label: 'Render',
    detail: 'Managed HTTPS with a repo-backed Docker service',
  },
  {
    id: 'fly',
    label: 'Fly.io',
    detail: 'Persistent remote gateway with Fly volumes and HTTPS',
  },
  {
    id: 'railway',
    label: 'Railway',
    detail: 'Simple Docker deploy with volume-backed state',
  },
]

const PROVIDER_OPTIONS: Array<{
  id: RemoteProvider
  label: string
  detail: string
}> = [
  { id: 'hetzner', label: 'Hetzner', detail: 'Cheap always-on VPS' },
  { id: 'digitalocean', label: 'DigitalOcean', detail: 'Droplet + user-data flow' },
  { id: 'vultr', label: 'Vultr', detail: 'Cloud Compute startup script' },
  { id: 'linode', label: 'Linode', detail: 'Simple Ubuntu VM path' },
  { id: 'lightsail', label: 'Lightsail', detail: 'AWS-hosted simple VPS' },
  { id: 'gcp', label: 'GCP', detail: 'Compute Engine VM' },
  { id: 'azure', label: 'Azure', detail: 'Ubuntu VM custom data' },
  { id: 'oci', label: 'OCI', detail: 'Oracle cloud-init bootstrap' },
  { id: 'generic', label: 'Generic', detail: 'Any Ubuntu 24.04 host' },
]

const USE_CASE_OPTIONS: Array<{
  id: UseCaseTemplate
  label: string
  detail: string
}> = [
  { id: 'local-dev', label: 'Local Dev', detail: 'Loopback-friendly defaults for one machine and quick setup.' },
  { id: 'single-vps', label: 'Single VPS', detail: 'Balanced default for most public or private VPS installs.' },
  { id: 'private-tailnet', label: 'Private Tailnet', detail: 'Keep the gateway private and expose it over a tailnet.' },
  { id: 'browser-heavy', label: 'Browser Heavy', detail: 'Roomier defaults for browser-backed nodes and automation.' },
  { id: 'team-control', label: 'Team Control', detail: 'Shared operator-friendly control plane defaults and backups.' },
]

const EXPOSURE_OPTIONS: Array<{
  id: ExposurePreset
  label: string
  detail: string
}> = [
  { id: 'private-lan', label: 'Private LAN', detail: 'Expose on LAN only and rely on your own firewall rules.' },
  { id: 'tailscale', label: 'Tailscale', detail: 'Loopback only plus a tailnet-facing Tailscale serve script.' },
  { id: 'caddy', label: 'Caddy', detail: 'Bundled reverse proxy with simple HTTPS termination.' },
  { id: 'nginx', label: 'Nginx', detail: 'Bundled reverse proxy config for teams with existing TLS handling.' },
  { id: 'ssh-tunnel', label: 'SSH Tunnel', detail: 'Keep it private and access the gateway through SSH port-forwarding.' },
]

function buildLocalRunCommand(port: number, token?: string | null): string {
  const parts = ['npx', 'openclaw', 'gateway', 'run', '--allow-unconfigured', '--force', '--bind', 'loopback', '--port', String(port)]
  if (token) parts.push('--auth', 'token', '--token', token)
  return parts.join(' ')
}

function buildLocalInstallCommand(port: number, token?: string | null): string {
  const parts = ['npx', 'openclaw', 'gateway', 'install', '--port', String(port)]
  if (token) parts.push('--token', token)
  return `${parts.join(' ')} && npx openclaw gateway start`
}

function parseMaybeUrl(value: string | null | undefined): URL | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return null
  try {
    return new URL(trimmed)
  } catch {
    try {
      return new URL(`http://${trimmed}`)
    } catch {
      return null
    }
  }
}

function isLocalEndpoint(value: string | null | undefined): boolean {
  const parsed = parseMaybeUrl(value)
  if (!parsed) return false
  const host = parsed.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

function inferPort(value: string | null | undefined, fallback = 18789): number {
  const parsed = parseMaybeUrl(value)
  if (!parsed?.port) return fallback
  const port = Number.parseInt(parsed.port, 10)
  return Number.isFinite(port) ? port : fallback
}

function inferRemoteTarget(value: string | null | undefined): string {
  const parsed = parseMaybeUrl(value)
  if (!parsed || isLocalEndpoint(value)) return ''
  const base = `${parsed.protocol}//${parsed.host}`
  return base.replace(/\/+$/, '')
}

function badgeTone(active: boolean): string {
  return active
    ? 'border-accent-bright/30 bg-accent-bright/10 text-accent-bright'
    : 'border-white/[0.08] bg-white/[0.02] text-text-2 hover:bg-white/[0.05]'
}

export function OpenClawDeployPanel(props: OpenClawDeployPanelProps) {
  const {
    endpoint,
    token,
    deployment,
    suggestedName,
    title = 'Smart Deploy OpenClaw',
    description = 'Launch a local gateway on this host or generate a remote bundle with opinionated defaults.',
    compact = false,
    onApply,
  } = props

  const [activeTab, setActiveTab] = useState<'local' | 'remote'>('local')
  const [localStatus, setLocalStatus] = useState<LocalDeployStatus | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<RemoteDeployStatus | null>(null)
  const [localPort, setLocalPort] = useState(() => inferPort(endpoint))
  const [deployToken, setDeployToken] = useState(token || '')
  const [remoteTarget, setRemoteTarget] = useState(() => inferRemoteTarget(endpoint))
  const [remoteScheme, setRemoteScheme] = useState<'http' | 'https'>(() => (
    typeof endpoint === 'string' && endpoint.trim().startsWith('http://') ? 'http' : 'https'
  ))
  const [remoteTemplate, setRemoteTemplate] = useState<RemoteTemplate>('docker')
  const [remoteProvider, setRemoteProvider] = useState<RemoteProvider>('hetzner')
  const [useCase, setUseCase] = useState<UseCaseTemplate>(() => deployment?.useCase || 'single-vps')
  const [exposure, setExposure] = useState<ExposurePreset>(() => deployment?.exposure || 'caddy')
  const [sshHost, setSshHost] = useState(() => deployment?.sshHost || inferRemoteTarget(endpoint))
  const [sshUser, setSshUser] = useState(() => deployment?.sshUser || 'root')
  const [sshPort, setSshPort] = useState(() => deployment?.sshPort || 22)
  const [sshKeyPath, setSshKeyPath] = useState(() => deployment?.sshKeyPath || '')
  const [sshTargetDir, setSshTargetDir] = useState(() => deployment?.sshTargetDir || '/opt/openclaw')
  const [restoreBackupPath, setRestoreBackupPath] = useState(() => deployment?.lastBackupPath || '')
  const [bundle, setBundle] = useState<DeployBundle | null>(null)
  const [bundleFile, setBundleFile] = useState('')
  const [loading, setLoading] = useState<'idle' | 'starting-local' | 'stopping-local' | 'restarting-local' | 'generating-bundle' | 'ssh-deploy' | 'verifying' | 'remote-action'>('idle')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copiedKey, setCopiedKey] = useState('')
  const [commandPreview, setCommandPreview] = useState('')
  const [verifySummary, setVerifySummary] = useState('')

  useEffect(() => {
    if (token && !deployToken) setDeployToken(token)
  }, [token, deployToken])

  useEffect(() => {
    if (endpoint && isLocalEndpoint(endpoint)) {
      setLocalPort(inferPort(endpoint))
      setActiveTab('local')
    } else if (endpoint && inferRemoteTarget(endpoint)) {
      setRemoteTarget(inferRemoteTarget(endpoint))
      setSshHost((current) => current || inferRemoteTarget(endpoint))
      setActiveTab('remote')
    }
  }, [endpoint])

  useEffect(() => {
    if (!deployment) return
    if (deployment.useCase) setUseCase(deployment.useCase)
    if (deployment.exposure) setExposure(deployment.exposure)
    if (deployment.sshHost) setSshHost(deployment.sshHost)
    if (deployment.sshUser) setSshUser(deployment.sshUser)
    if (deployment.sshPort) setSshPort(deployment.sshPort)
    if (deployment.sshKeyPath) setSshKeyPath(deployment.sshKeyPath)
    if (deployment.sshTargetDir) setSshTargetDir(deployment.sshTargetDir)
    if (deployment.lastBackupPath) setRestoreBackupPath(deployment.lastBackupPath)
  }, [deployment])

  useEffect(() => {
    let cancelled = false
    api<DeployStatusResponse>('GET', '/openclaw/deploy')
      .then((result) => {
        if (!cancelled) {
          setLocalStatus(result.local)
          setRemoteStatus(result.remote || null)
          if (result.local.token) {
            setDeployToken((current) => current || result.local.token || '')
          }
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!remoteStatus?.active) return
    const timer = window.setInterval(() => {
      api<DeployStatusResponse>('GET', '/openclaw/deploy')
        .then((result) => {
          setLocalStatus(result.local)
          setRemoteStatus(result.remote || null)
        })
        .catch(() => {})
    }, 2500)
    return () => window.clearInterval(timer)
  }, [remoteStatus?.active])

  const selectedFile = useMemo(() => {
    if (!bundle) return null
    return bundle.files.find((file) => file.name === bundleFile) || bundle.files[0] || null
  }, [bundle, bundleFile])
  const localLaunchCommand = useMemo(() => {
    const typedToken = deployToken.trim()
    if (typedToken) return buildLocalRunCommand(localPort, typedToken)
    if (localStatus?.launchCommand) return localStatus.launchCommand
    return buildLocalRunCommand(localPort)
  }, [deployToken, localPort, localStatus?.launchCommand])
  const localInstallCommand = useMemo(() => {
    const typedToken = deployToken.trim()
    if (typedToken) return buildLocalInstallCommand(localPort, typedToken)
    if (localStatus?.installCommand) return localStatus.installCommand
    return buildLocalInstallCommand(localPort)
  }, [deployToken, localPort, localStatus?.installCommand])

  const showMessage = (next: string) => {
    setMessage(next)
    if (!next) return
    window.setTimeout(() => {
      setMessage((current) => (current === next ? '' : current))
    }, 2200)
  }

  const onCopied = async (key: string, value: string) => {
    const ok = await copyTextToClipboard(value)
    if (!ok) return
    setCopiedKey(key)
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? '' : current))
    }, 1200)
  }

  const applyDeploymentPatch = async (patch: ApplyPatch) => {
    await Promise.resolve(onApply?.(patch))
  }

  const buildRemoteDeploymentPatch = (overrides?: Partial<NonNullable<ApplyPatch['deployment']>>): NonNullable<ApplyPatch['deployment']> => ({
    method: overrides?.method || (remoteTemplate === 'docker' ? 'bundle' : 'bundle'),
    provider: overrides?.provider || (remoteTemplate === 'docker' ? remoteProvider : remoteTemplate),
    remoteTarget: overrides?.remoteTarget || remoteTemplate,
    useCase,
    exposure,
    sshHost: sshHost.trim() || null,
    sshUser: sshUser.trim() || null,
    sshPort,
    sshKeyPath: sshKeyPath.trim() || null,
    sshTargetDir: sshTargetDir.trim() || null,
    lastDeployAt: overrides?.lastDeployAt ?? null,
    lastDeployAction: overrides?.lastDeployAction ?? null,
    lastDeploySummary: overrides?.lastDeploySummary ?? null,
    lastDeployProcessId: overrides?.lastDeployProcessId ?? null,
    lastVerifiedAt: overrides?.lastVerifiedAt ?? null,
    lastVerifiedOk: overrides?.lastVerifiedOk ?? null,
    lastVerifiedMessage: overrides?.lastVerifiedMessage ?? null,
    lastBackupPath: overrides?.lastBackupPath ?? deployment?.lastBackupPath ?? null,
  })

  const handleStartLocal = async () => {
    setLoading('starting-local')
    setError('')
    setVerifySummary('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'start-local',
        port: localPort,
        token: deployToken.trim() || undefined,
      })
      if (!result.ok || !result.local) throw new Error(result.error || 'Local OpenClaw deploy failed.')
      setLocalStatus(result.local)
      if (result.token) setDeployToken(result.token)
      const verify = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'verify',
        endpoint: result.local.endpoint,
        token: result.token || deployToken || undefined,
      }).catch(() => ({ ok: false } as DeployActionResponse))
      if (verify.verify) {
        setVerifySummary(verify.verify.ok
          ? `Verified ${verify.verify.endpoint} with ${verify.verify.models.length} model${verify.verify.models.length === 1 ? '' : 's'}.`
          : (verify.verify.error || verify.verify.hint || 'Verification failed.'))
      }
      await applyDeploymentPatch({
        endpoint: result.local.endpoint,
        token: result.token || deployToken,
        name: suggestedName || `Local OpenClaw ${result.local.port}`,
        notes: 'Managed by SwarmClaw local deploy.',
        deployment: {
          method: 'local',
          provider: 'local',
          useCase: 'local-dev',
          exposure: 'private-lan',
          lastDeployAt: Date.now(),
          lastDeployAction: 'start-local',
          lastDeploySummary: 'Managed local OpenClaw runtime started from SwarmClaw.',
          lastVerifiedAt: verify.verify ? Date.now() : null,
          lastVerifiedOk: verify.verify?.ok ?? null,
          lastVerifiedMessage: verify.verify
            ? (verify.verify.error || verify.verify.hint || 'Verified successfully.')
            : null,
        },
      })
      showMessage('Local OpenClaw started and applied to this connection.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Local OpenClaw deploy failed.')
    } finally {
      setLoading('idle')
    }
  }

  const handleStopLocal = async () => {
    setLoading('stopping-local')
    setError('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', { action: 'stop-local' })
      if (!result.ok || !result.local) throw new Error(result.error || 'Failed to stop local OpenClaw.')
      setLocalStatus(result.local)
      showMessage('Stopped managed local OpenClaw runtime.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to stop local OpenClaw.')
    } finally {
      setLoading('idle')
    }
  }

  const handleRestartLocal = async () => {
    setLoading('restarting-local')
    setError('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'restart-local',
        port: localPort,
        token: deployToken.trim() || undefined,
      })
      if (!result.ok || !result.local) throw new Error(result.error || 'Failed to restart local OpenClaw.')
      setLocalStatus(result.local)
      if (result.token) setDeployToken(result.token)
      await applyDeploymentPatch({
        endpoint: result.local.endpoint,
        token: result.token || deployToken,
        name: suggestedName || `Local OpenClaw ${result.local.port}`,
        notes: 'Managed by SwarmClaw local deploy.',
        deployment: {
          method: 'local',
          provider: 'local',
          useCase: 'local-dev',
          exposure: 'private-lan',
          lastDeployAt: Date.now(),
          lastDeployAction: 'restart-local',
          lastDeploySummary: 'Managed local OpenClaw runtime restarted from SwarmClaw.',
        },
      })
      showMessage('Restarted managed local OpenClaw runtime.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restart local OpenClaw.')
    } finally {
      setLoading('idle')
    }
  }

  const handleGenerateBundle = async () => {
    setLoading('generating-bundle')
    setError('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'bundle',
        template: remoteTemplate,
        target: remoteTarget.trim(),
        scheme: remoteScheme,
        token: deployToken.trim() || undefined,
        provider: remoteProvider,
        useCase,
        exposure,
      })
      if (!result.ok || !result.bundle) throw new Error(result.error || 'Failed to generate OpenClaw deploy bundle.')
      setBundle(result.bundle)
      setBundleFile(result.bundle.files[0]?.name || '')
      setDeployToken(result.bundle.token)
      await applyDeploymentPatch({
        endpoint: result.bundle.endpoint,
        token: result.bundle.token,
        name: suggestedName || result.bundle.title,
        notes: `OpenClaw remote deploy template: ${result.bundle.title}`,
        deployment: buildRemoteDeploymentPatch({
          method: 'bundle',
          provider: remoteTemplate === 'docker' ? remoteProvider : remoteTemplate,
          remoteTarget: remoteTemplate,
          lastDeployAction: 'bundle',
          lastDeploySummary: `Generated ${result.bundle.title} from SwarmClaw.`,
        }),
      })
      showMessage('Remote bundle generated and applied to this connection.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate OpenClaw deploy bundle.')
    } finally {
      setLoading('idle')
    }
  }

  const handleVerify = async (overrideEndpoint?: string | null, overrideToken?: string | null) => {
    setLoading('verifying')
    setError('')
    try {
      const endpointToVerify = (overrideEndpoint || bundle?.endpoint || endpoint || '').trim()
      const tokenToVerify = (overrideToken || deployToken || '').trim()
      if (!endpointToVerify) throw new Error('Set an OpenClaw endpoint before verifying.')
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'verify',
        endpoint: endpointToVerify,
        token: tokenToVerify || undefined,
      })
      if (!result.verify) throw new Error(result.error || 'Verification failed.')
      const summary = result.verify.ok
        ? `Verified ${result.verify.endpoint} with ${result.verify.models.length} model${result.verify.models.length === 1 ? '' : 's'}.`
        : (result.verify.error || result.verify.hint || 'Verification failed.')
      setVerifySummary(summary)
      await applyDeploymentPatch({
        endpoint: result.verify.endpoint,
        token: tokenToVerify || undefined,
        deployment: buildRemoteDeploymentPatch({
          method: deployment?.method || (isLocalEndpoint(result.verify.endpoint) ? 'local' : 'bundle'),
          lastVerifiedAt: Date.now(),
          lastVerifiedOk: result.verify.ok,
          lastVerifiedMessage: summary,
        }),
      })
      showMessage(result.verify.ok ? 'OpenClaw verification passed.' : summary)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed.')
    } finally {
      setLoading('idle')
    }
  }

  const handleSshDeploy = async () => {
    setLoading('ssh-deploy')
    setError('')
    setVerifySummary('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'ssh-deploy',
        template: remoteTemplate,
        target: remoteTarget.trim(),
        scheme: remoteScheme,
        token: deployToken.trim() || undefined,
        provider: remoteProvider,
        useCase,
        exposure,
        ssh: {
          host: sshHost.trim(),
          user: sshUser.trim() || undefined,
          port: sshPort,
          keyPath: sshKeyPath.trim() || undefined,
          targetDir: sshTargetDir.trim() || undefined,
        },
      })
      if (!result.ok) throw new Error(result.error || 'Failed to start SSH deploy.')
      if (result.bundle) {
        setBundle(result.bundle)
        setBundleFile(result.bundle.files[0]?.name || '')
      }
      if (result.token) setDeployToken(result.token)
      setRemoteStatus(result.remote || null)
      setCommandPreview(result.commandPreview || '')
      await applyDeploymentPatch({
        endpoint: result.bundle?.endpoint || endpoint || undefined,
        token: result.token || deployToken,
        name: suggestedName || result.bundle?.title || `SSH OpenClaw ${sshHost.trim()}`,
        notes: `Official OpenClaw deployed over SSH to ${sshHost.trim()}.`,
        deployment: buildRemoteDeploymentPatch({
          method: 'ssh',
          provider: remoteProvider,
          lastDeployAt: Date.now(),
          lastDeployAction: 'ssh-deploy',
          lastDeploySummary: result.summary || `Started SSH deploy to ${sshHost.trim()}.`,
          lastDeployProcessId: result.processId || null,
        }),
      })
      showMessage(result.summary || 'Started SSH deploy.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start SSH deploy.')
    } finally {
      setLoading('idle')
    }
  }

  const handleRemoteLifecycle = async (
    action: 'remote-start' | 'remote-stop' | 'remote-restart' | 'remote-upgrade' | 'remote-backup' | 'remote-restore' | 'remote-rotate-token',
  ) => {
    setLoading('remote-action')
    setError('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action,
        token: action === 'remote-rotate-token' ? (deployToken.trim() || undefined) : undefined,
        backupPath: action === 'remote-restore' ? (restoreBackupPath.trim() || undefined) : undefined,
        ssh: {
          host: sshHost.trim(),
          user: sshUser.trim() || undefined,
          port: sshPort,
          keyPath: sshKeyPath.trim() || undefined,
          targetDir: sshTargetDir.trim() || undefined,
        },
      })
      if (!result.ok) throw new Error(result.error || 'Remote lifecycle action failed.')
      if (result.token) setDeployToken(result.token)
      setRemoteStatus(result.remote || null)
      setCommandPreview(result.commandPreview || '')
      if (result.remote?.lastBackupPath) {
        setRestoreBackupPath(result.remote.lastBackupPath)
      }
      await applyDeploymentPatch({
        token: result.token || undefined,
        deployment: buildRemoteDeploymentPatch({
          method: 'ssh',
          provider: remoteProvider,
          lastDeployAt: Date.now(),
          lastDeployAction: action,
          lastDeploySummary: result.summary || action,
          lastDeployProcessId: result.processId || null,
          lastBackupPath: action === 'remote-backup' || action === 'remote-restore'
            ? (result.remote?.lastBackupPath || restoreBackupPath.trim() || null)
            : undefined,
        }),
      })
      showMessage(result.summary || 'Remote lifecycle action started.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Remote lifecycle action failed.')
    } finally {
      setLoading('idle')
    }
  }

  return (
    <div className={`rounded-[16px] border border-white/[0.08] bg-surface ${compact ? 'p-4' : 'p-5'} text-left`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-display text-[16px] font-700 text-text">{title}</div>
          <p className="mt-1 text-[12px] text-text-3 leading-relaxed">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('local')}
            className={`rounded-[10px] border px-3 py-1.5 text-[12px] font-700 transition-all cursor-pointer ${badgeTone(activeTab === 'local')}`}
          >
            Local
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('remote')}
            className={`rounded-[10px] border px-3 py-1.5 text-[12px] font-700 transition-all cursor-pointer ${badgeTone(activeTab === 'remote')}`}
          >
            Remote
          </button>
        </div>
      </div>

      {activeTab === 'local' && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-[120px_1fr]">
            <div>
              <label className="block text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Port</label>
              <input
                type="number"
                value={localPort}
                onChange={(e) => setLocalPort(Number.parseInt(e.target.value, 10) || 18789)}
                className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text outline-none focus:border-accent-bright/30"
              />
            </div>
            <div>
              <label className="block text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Gateway token</label>
              <input
                type="text"
                value={deployToken}
                onChange={(e) => setDeployToken(e.target.value)}
                placeholder="Leave blank to generate a secure token"
                className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
              />
            </div>
          </div>

          <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-600 text-text">Managed local runtime</div>
                <div className="mt-1 text-[12px] text-text-3">
                  One-click bring-up on the same machine running SwarmClaw. Good for quickstarts and non-technical local installs.
                </div>
              </div>
              <div className={`rounded-full px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${
                localStatus?.running
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : 'bg-white/[0.05] text-text-3'
              }`}>
                {localStatus?.running ? 'running' : 'idle'}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleStartLocal}
                disabled={loading !== 'idle'}
                className="rounded-[10px] bg-accent-bright px-3.5 py-2 text-[12px] font-700 text-white border-none cursor-pointer hover:brightness-110 transition-all disabled:opacity-40"
              >
                {loading === 'starting-local' ? 'Starting…' : 'Deploy on This Host'}
              </button>
              {localStatus?.running && (
                <button
                  type="button"
                  onClick={handleRestartLocal}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  {loading === 'restarting-local' ? 'Restarting…' : 'Restart'}
                </button>
              )}
              {localStatus?.running && (
                <button
                  type="button"
                  onClick={() => void handleVerify(localStatus.endpoint, deployToken || localStatus.token)}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  {loading === 'verifying' ? 'Verifying…' : 'Verify'}
                </button>
              )}
              {localStatus?.running && (
                <button
                  type="button"
                  onClick={handleStopLocal}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  {loading === 'stopping-local' ? 'Stopping…' : 'Stop'}
                </button>
              )}
              <button
                type="button"
                onClick={() => onCopied('local-launch', localLaunchCommand)}
                disabled={!localLaunchCommand}
                className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
              >
                {copiedKey === 'local-launch' ? 'Copied launch' : 'Copy launch cmd'}
              </button>
              <button
                type="button"
                onClick={() => onCopied('local-install', localInstallCommand)}
                disabled={!localInstallCommand}
                className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
              >
                {copiedKey === 'local-install' ? 'Copied install' : 'Copy service cmd'}
              </button>
              <button
                type="button"
                onClick={() => onCopied('local-token', deployToken.trim() || localStatus?.token || '')}
                disabled={!deployToken.trim() && !localStatus?.token}
                className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
              >
                {copiedKey === 'local-token' ? 'Copied token' : 'Copy token'}
              </button>
            </div>

            {localStatus && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Endpoint</div>
                  <div className="mt-1 text-[12px] text-text-2 font-mono break-all">{localStatus.endpoint}</div>
                </div>
                <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Persistent install</div>
                  <div className="mt-1 text-[12px] text-text-3 leading-relaxed">
                    For a durable OS service, use the generated install command after the quick deploy works.
                  </div>
                </div>
                {verifySummary && (
                  <div className="rounded-[10px] border border-white/[0.05] bg-white/[0.02] px-3 py-2 md:col-span-2">
                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Verification</div>
                    <div className="mt-1 text-[12px] text-text-2 leading-relaxed">{verifySummary}</div>
                  </div>
                )}
              </div>
            )}

            {!!localStatus?.tail && (
              <pre className="mt-3 overflow-x-auto rounded-[10px] border border-white/[0.05] bg-black/20 px-3 py-2 text-[11px] text-text-2/80 whitespace-pre-wrap">
                {localStatus.tail}
              </pre>
            )}
          </div>
        </div>
      )}

      {activeTab === 'remote' && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_120px]">
            <div>
              <label className="block text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Public host or URL</label>
              <input
                type="text"
                value={remoteTarget}
                onChange={(e) => setRemoteTarget(e.target.value)}
                placeholder="openclaw.example.com or https://openclaw.example.com"
                className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
              />
            </div>
            <div>
              <label className="block text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Scheme</label>
              <select
                value={remoteScheme}
                onChange={(e) => setRemoteScheme(e.target.value === 'http' ? 'http' : 'https')}
                className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text outline-none focus:border-accent-bright/30"
              >
                <option value="https">https</option>
                <option value="http">http</option>
              </select>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Deploy target</div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {TEMPLATE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setRemoteTemplate(option.id)}
                  className={`rounded-[12px] border px-3 py-3 text-left transition-all cursor-pointer ${badgeTone(remoteTemplate === option.id)}`}
                >
                  <div className="text-[13px] font-700">{option.label}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-text-3">{option.detail}</div>
                </button>
              ))}
            </div>
          </div>

          {remoteTemplate === 'docker' && (
            <div className="space-y-4">
              <div className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">VPS provider</div>
              <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-5">
                {PROVIDER_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setRemoteProvider(option.id)}
                    className={`rounded-[12px] border px-3 py-3 text-left transition-all cursor-pointer ${badgeTone(remoteProvider === option.id)}`}
                  >
                    <div className="text-[13px] font-700">{option.label}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-text-3">{option.detail}</div>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                SwarmClaw generates a provider-specific runbook plus a cloud-init quickstart, but the runtime itself still comes from the official OpenClaw Docker image.
              </p>

              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Use case preset</div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                  {USE_CASE_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setUseCase(option.id)}
                      className={`rounded-[12px] border px-3 py-3 text-left transition-all cursor-pointer ${badgeTone(useCase === option.id)}`}
                    >
                      <div className="text-[13px] font-700">{option.label}</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-text-3">{option.detail}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-2">Safe exposure preset</div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                  {EXPOSURE_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setExposure(option.id)}
                      className={`rounded-[12px] border px-3 py-3 text-left transition-all cursor-pointer ${badgeTone(exposure === option.id)}`}
                    >
                      <div className="text-[13px] font-700">{option.label}</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-text-3">{option.detail}</div>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  Smart Deploy keeps the OpenClaw runtime official-only and generates the surrounding exposure config in-house so operators do not need third-party deploy services.
                </p>
              </div>

              <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="text-[11px] font-700 uppercase tracking-[0.08em] text-text-3/70 mb-3">In-House SSH Deploy</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="gateway.your-vps.com"
                    className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
                  />
                  <input
                    type="text"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root"
                    className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
                  />
                  <input
                    type="number"
                    value={sshPort}
                    onChange={(e) => setSshPort(Number.parseInt(e.target.value, 10) || 22)}
                    placeholder="22"
                    className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
                  />
                  <input
                    type="text"
                    value={sshKeyPath}
                    onChange={(e) => setSshKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
                  />
                </div>
                <input
                  type="text"
                  value={sshTargetDir}
                  onChange={(e) => setSshTargetDir(e.target.value)}
                  placeholder="/opt/openclaw"
                  className="mt-3 w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
                />
                <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                  SwarmClaw will push the generated official-image bundle to this host over SSH and run the bootstrap there. This stays inside your own infra and does not rely on outside OpenClaw deployers.
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleGenerateBundle}
              disabled={loading !== 'idle'}
              className="rounded-[10px] bg-accent-bright px-3.5 py-2 text-[12px] font-700 text-white border-none cursor-pointer hover:brightness-110 transition-all disabled:opacity-40"
            >
              {loading === 'generating-bundle' ? 'Generating…' : 'Generate Bundle'}
            </button>
            {remoteTemplate === 'docker' && (
              <button
                type="button"
                onClick={handleSshDeploy}
                disabled={loading !== 'idle' || !sshHost.trim()}
                className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
              >
                {loading === 'ssh-deploy' ? 'Deploying…' : 'Deploy Over SSH'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleVerify(bundle?.endpoint || endpoint || remoteTarget, deployToken)}
              disabled={loading !== 'idle' || (!bundle?.endpoint && !endpoint && !remoteTarget.trim())}
              className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
            >
              {loading === 'verifying' ? 'Verifying…' : 'Verify Endpoint'}
            </button>
            {bundle && (
              <button
                type="button"
                onClick={() => onCopied('remote-token', bundle.token)}
                className="rounded-[10px] border border-white/[0.08] bg-transparent px-3.5 py-2 text-[12px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all"
              >
                {copiedKey === 'remote-token' ? 'Copied token' : 'Copy token'}
              </button>
            )}
          </div>

          {remoteTemplate === 'docker' && sshHost.trim() && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-start')}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  Start
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-restart')}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  Restart
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-upgrade')}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  Upgrade
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-backup')}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  Backup
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-rotate-token')}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  Rotate token
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-stop')}
                  disabled={loading !== 'idle'}
                  className="rounded-[10px] border border-red-400/20 bg-red-400/[0.06] px-3 py-1.5 text-[11px] font-700 text-red-300 cursor-pointer hover:bg-red-400/[0.1] transition-all disabled:opacity-40"
                >
                  Stop
                </button>
              </div>
              <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                <input
                  type="text"
                  value={restoreBackupPath}
                  onChange={(e) => setRestoreBackupPath(e.target.value)}
                  placeholder="/opt/openclaw/backups/openclaw-backup-123456789.tgz"
                  className="w-full rounded-[12px] border border-white/[0.08] bg-bg px-3 py-3 text-[13px] text-text font-mono outline-none focus:border-accent-bright/30"
                />
                <button
                  type="button"
                  onClick={() => void handleRemoteLifecycle('remote-restore')}
                  disabled={loading !== 'idle' || !restoreBackupPath.trim()}
                  className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40"
                >
                  Restore backup
                </button>
              </div>
            </div>
          )}

          {(verifySummary || commandPreview || remoteStatus) && (
            <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-4">
              {verifySummary && (
                <div className="text-[12px] text-text-2 leading-relaxed">{verifySummary}</div>
              )}
              {remoteStatus && (
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Remote action</div>
                    <div className="mt-1 text-[12px] text-text-2">{remoteStatus.action || remoteStatus.lastSummary || 'Idle'}</div>
                  </div>
                  <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Target</div>
                    <div className="mt-1 text-[12px] text-text-2 font-mono break-all">{remoteStatus.target || sshHost || 'n/a'}</div>
                  </div>
                  <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Status</div>
                    <div className="mt-1 text-[12px] text-text-2">{remoteStatus.status}</div>
                  </div>
                </div>
              )}
              {(commandPreview || remoteStatus?.lastCommandPreview) && (
                <pre className="mt-3 overflow-x-auto rounded-[10px] border border-white/[0.05] bg-black/20 px-3 py-3 text-[11px] text-text-2/80 whitespace-pre-wrap">
                  {commandPreview || remoteStatus?.lastCommandPreview}
                </pre>
              )}
              {!!remoteStatus?.tail && (
                <pre className="mt-3 overflow-x-auto rounded-[10px] border border-white/[0.05] bg-black/20 px-3 py-3 text-[11px] text-text-2/80 whitespace-pre-wrap">
                  {remoteStatus.tail}
                </pre>
              )}
              {remoteStatus?.lastBackupPath && (
                <div className="mt-3 text-[12px] text-text-3">
                  Last backup path: <code className="text-text-2">{remoteStatus.lastBackupPath}</code>
                </div>
              )}
            </div>
          )}

          {bundle && (
            <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[14px] font-700 text-text">{bundle.title}</div>
                  <p className="mt-1 text-[12px] text-text-3 leading-relaxed">{bundle.summary}</p>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Endpoint</div>
                    <div className="mt-1 text-[11px] font-mono text-text-2 break-all">{bundle.endpoint}</div>
                  </div>
                  <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60">Host path</div>
                    <div className="mt-1 text-[11px] text-text-2">{bundle.providerLabel}</div>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid gap-2">
                {bundle.runbook.map((step, index) => (
                  <div key={`${bundle.template}:${index}`} className="text-[12px] text-text-2 leading-relaxed">
                    {index + 1}. {step}
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {bundle.files.map((file) => (
                  <button
                    key={file.name}
                    type="button"
                    onClick={() => setBundleFile(file.name)}
                    className={`rounded-[10px] border px-3 py-1.5 text-[12px] font-700 transition-all cursor-pointer ${badgeTone(selectedFile?.name === file.name)}`}
                  >
                    {file.name}
                  </button>
                ))}
              </div>

              {selectedFile && (
                <div className="mt-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-[12px] font-600 text-text-2">{selectedFile.name}</div>
                    <button
                      type="button"
                      onClick={() => onCopied(`file:${selectedFile.name}`, selectedFile.content)}
                      className="rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-700 text-text-2 cursor-pointer hover:bg-white/[0.04] transition-all"
                    >
                      {copiedKey === `file:${selectedFile.name}` ? 'Copied' : 'Copy file'}
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded-[10px] border border-white/[0.05] bg-black/20 px-3 py-3 text-[11px] text-text-2/80 whitespace-pre-wrap">
                    {selectedFile.content}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(message || error || localStatus?.lastError || remoteStatus?.lastError) && (
        <div className={`mt-4 rounded-[12px] border px-3 py-2 text-[12px] ${
          error || localStatus?.lastError || remoteStatus?.lastError
            ? 'border-red-400/20 bg-red-400/[0.06] text-red-200'
            : 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200'
        }`}>
          {error || localStatus?.lastError || remoteStatus?.lastError || message}
        </div>
      )}
    </div>
  )
}
