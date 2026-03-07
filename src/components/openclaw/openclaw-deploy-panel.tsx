'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api-client'
import { copyTextToClipboard } from '@/lib/clipboard'

type RemoteTemplate = 'docker' | 'render' | 'fly' | 'railway'
type RemoteProvider = 'hetzner' | 'digitalocean' | 'vultr' | 'linode' | 'lightsail' | 'gcp' | 'azure' | 'oci' | 'generic'

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

interface DeployFile {
  name: string
  language: 'bash' | 'yaml' | 'env' | 'toml' | 'text'
  content: string
}

interface DeployBundle {
  template: RemoteTemplate
  provider: RemoteProvider
  providerLabel: string
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
}

interface DeployActionResponse {
  ok: boolean
  local?: LocalDeployStatus
  token?: string
  bundle?: DeployBundle
  error?: string
}

interface ApplyPatch {
  endpoint?: string
  token?: string
  name?: string
  notes?: string
}

interface OpenClawDeployPanelProps {
  endpoint?: string | null
  token?: string | null
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
    suggestedName,
    title = 'Smart Deploy OpenClaw',
    description = 'Launch a local gateway on this host or generate a remote bundle with opinionated defaults.',
    compact = false,
    onApply,
  } = props

  const [activeTab, setActiveTab] = useState<'local' | 'remote'>('local')
  const [localStatus, setLocalStatus] = useState<LocalDeployStatus | null>(null)
  const [localPort, setLocalPort] = useState(() => inferPort(endpoint))
  const [deployToken, setDeployToken] = useState(token || '')
  const [remoteTarget, setRemoteTarget] = useState(() => inferRemoteTarget(endpoint))
  const [remoteScheme, setRemoteScheme] = useState<'http' | 'https'>(() => (
    typeof endpoint === 'string' && endpoint.trim().startsWith('http://') ? 'http' : 'https'
  ))
  const [remoteTemplate, setRemoteTemplate] = useState<RemoteTemplate>('docker')
  const [remoteProvider, setRemoteProvider] = useState<RemoteProvider>('hetzner')
  const [bundle, setBundle] = useState<DeployBundle | null>(null)
  const [bundleFile, setBundleFile] = useState('')
  const [loading, setLoading] = useState<'idle' | 'starting-local' | 'stopping-local' | 'generating-bundle'>('idle')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copiedKey, setCopiedKey] = useState('')

  useEffect(() => {
    if (token && !deployToken) setDeployToken(token)
  }, [token, deployToken])

  useEffect(() => {
    if (endpoint && isLocalEndpoint(endpoint)) {
      setLocalPort(inferPort(endpoint))
      setActiveTab('local')
    } else if (endpoint && inferRemoteTarget(endpoint)) {
      setRemoteTarget(inferRemoteTarget(endpoint))
      setActiveTab('remote')
    }
  }, [endpoint])

  useEffect(() => {
    let cancelled = false
    api<DeployStatusResponse>('GET', '/openclaw/deploy')
      .then((result) => {
        if (!cancelled) {
          setLocalStatus(result.local)
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

  const handleStartLocal = async () => {
    setLoading('starting-local')
    setError('')
    try {
      const result = await api<DeployActionResponse>('POST', '/openclaw/deploy', {
        action: 'start-local',
        port: localPort,
        token: deployToken.trim() || undefined,
      })
      if (!result.ok || !result.local) throw new Error(result.error || 'Local OpenClaw deploy failed.')
      setLocalStatus(result.local)
      if (result.token) setDeployToken(result.token)
      await Promise.resolve(onApply?.({
        endpoint: result.local.endpoint,
        token: result.token || deployToken,
        name: suggestedName || `Local OpenClaw ${result.local.port}`,
        notes: 'Managed by SwarmClaw local deploy.',
      }))
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
      })
      if (!result.ok || !result.bundle) throw new Error(result.error || 'Failed to generate OpenClaw deploy bundle.')
      setBundle(result.bundle)
      setBundleFile(result.bundle.files[0]?.name || '')
      setDeployToken(result.bundle.token)
      await Promise.resolve(onApply?.({
        endpoint: result.bundle.endpoint,
        token: result.bundle.token,
        name: suggestedName || result.bundle.title,
        notes: `OpenClaw remote deploy template: ${result.bundle.title}`,
      }))
      showMessage('Remote bundle generated and applied to this connection.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to generate OpenClaw deploy bundle.')
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
            <div>
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

      {(message || error || localStatus?.lastError) && (
        <div className={`mt-4 rounded-[12px] border px-3 py-2 text-[12px] ${
          error || localStatus?.lastError
            ? 'border-red-400/20 bg-red-400/[0.06] text-red-200'
            : 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200'
        }`}>
          {error || localStatus?.lastError || message}
        </div>
      )}
    </div>
  )
}
