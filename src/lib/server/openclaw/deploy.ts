import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hmrSingleton, sleep } from '@/lib/shared-utils'
import {
  getManagedProcess,
  killManagedProcess,
  removeManagedProcess,
  startManagedProcess,
  type ProcessStatus,
} from '@/lib/server/runtime/process-manager'
import { normalizeOpenClawEndpoint, deriveOpenClawWsUrl } from '@/lib/openclaw/openclaw-endpoint'
import { probeOpenClawHealth, type OpenClawHealthResult } from './health'
import { DATA_DIR } from '../data-dir'

export type OpenClawRemoteDeployTemplate = 'docker' | 'render' | 'fly' | 'railway'
export type OpenClawRemoteDeployProvider =
  | 'hetzner'
  | 'digitalocean'
  | 'vultr'
  | 'linode'
  | 'lightsail'
  | 'gcp'
  | 'azure'
  | 'oci'
  | 'generic'
export type OpenClawUseCaseTemplate = 'local-dev' | 'single-vps' | 'private-tailnet' | 'browser-heavy' | 'team-control'
export type OpenClawExposurePreset = 'private-lan' | 'tailscale' | 'caddy' | 'nginx' | 'ssh-tunnel'

export interface OpenClawLocalDeployStatus {
  id: string
  name: string
  isPrimary: boolean
  running: boolean
  processId: string | null
  pid: number | null
  port: number
  endpoint: string
  wsUrl: string
  token: string | null
  stateDir: string
  configPath: string
  workspaceDir: string
  startedAt: number | null
  createdAt: number
  updatedAt: number
  tail: string
  lastError: string | null
  launchCommand: string
  installCommand: string
}

export interface OpenClawLocalDeployCollectionStatus {
  primaryId: string | null
  items: OpenClawLocalDeployStatus[]
}

export interface OpenClawRemoteDeployStatus {
  id: string
  name: string
  isPrimary: boolean
  active: boolean
  processId: string | null
  pid: number | null
  action: string | null
  target: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
  status: ProcessStatus | 'idle'
  exitCode: number | null
  tail: string
  lastError: string | null
  lastSummary: string | null
  lastCommandPreview: string | null
  lastBackupPath: string | null
}

export interface OpenClawRemoteDeployCollectionStatus {
  primaryId: string | null
  items: OpenClawRemoteDeployStatus[]
}

export interface OpenClawDeployBundleFile {
  name: string
  language: 'bash' | 'yaml' | 'env' | 'toml' | 'text'
  content: string
}

export interface OpenClawDeployBundle {
  template: OpenClawRemoteDeployTemplate
  provider: OpenClawRemoteDeployProvider
  providerLabel: string
  useCase: OpenClawUseCaseTemplate
  exposure: OpenClawExposurePreset
  title: string
  summary: string
  endpoint: string
  wsUrl: string
  token: string
  runbook: string[]
  files: OpenClawDeployBundleFile[]
}

export interface OpenClawSshConfig {
  host: string
  user?: string | null
  port?: number | null
  keyPath?: string | null
  targetDir?: string | null
}

export interface OpenClawRemoteCommandResult {
  ok: boolean
  started: boolean
  remoteId?: string | null
  processId?: string | null
  summary: string
  commandPreview: string
  token?: string
  bundle?: OpenClawDeployBundle
}

interface LocalRuntimeState {
  id: string
  name: string | null
  processId: string | null
  port: number
  endpoint: string
  wsUrl: string
  token: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
  lastError: string | null
}

interface LocalRuntimePaths {
  rootDir: string
  stateDir: string
  configPath: string
  workspaceDir: string
}

interface RemoteRuntimeState {
  id: string
  name: string | null
  processId: string | null
  action: string | null
  target: string | null
  startedAt: number | null
  createdAt: number
  updatedAt: number
  lastError: string | null
  lastSummary: string | null
  lastCommandPreview: string | null
  lastBackupPath: string | null
}

interface DeployRuntimeState {
  locals: Record<string, LocalRuntimeState>
  primaryLocalId: string | null
  remotes: Record<string, RemoteRuntimeState>
  primaryRemoteId: string | null
}

interface RemoteProviderMeta {
  id: OpenClawRemoteDeployProvider
  label: string
  shortLabel: string
  bootstrapHint: string
  summary: string
}

interface UseCaseMeta {
  id: OpenClawUseCaseTemplate
  label: string
  summary: string
  detail: string
  defaultExposure: OpenClawExposurePreset
  hostBind: string
  nodeOptions: string | null
}

interface ExposureMeta {
  id: OpenClawExposurePreset
  label: string
  summary: string
}

const DEFAULT_LOCAL_PORT = 18789
const DEFAULT_REMOTE_PORT = 18789
const OC_DEPLOY_KEY = '__swarmclaw_openclaw_deploy__'

const REMOTE_PROVIDER_META: Record<OpenClawRemoteDeployProvider, RemoteProviderMeta> = {
  hetzner: {
    id: 'hetzner',
    label: 'Hetzner Cloud',
    shortLabel: 'Hetzner',
    bootstrapHint: 'Paste cloud-init.yaml into the Cloud Config field when you create the server.',
    summary: 'Cheap Ubuntu VPS with excellent fit for always-on OpenClaw control planes.',
  },
  digitalocean: {
    id: 'digitalocean',
    label: 'DigitalOcean Droplet',
    shortLabel: 'DigitalOcean',
    bootstrapHint: 'Paste cloud-init.yaml into the User Data field when you create the Droplet.',
    summary: 'Simple Ubuntu VPS path with predictable pricing and easy DNS + volume add-ons.',
  },
  vultr: {
    id: 'vultr',
    label: 'Vultr Cloud Compute',
    shortLabel: 'Vultr',
    bootstrapHint: 'Paste cloud-init.yaml into User Data / Startup Script on the instance create screen.',
    summary: 'Straightforward VPS deployment with broad region coverage.',
  },
  linode: {
    id: 'linode',
    label: 'Linode',
    shortLabel: 'Linode',
    bootstrapHint: 'Paste cloud-init.yaml into your instance User Data during provisioning.',
    summary: 'Good fit for users who want an uncomplicated Linux VM with persistent disks.',
  },
  lightsail: {
    id: 'lightsail',
    label: 'AWS Lightsail',
    shortLabel: 'Lightsail',
    bootstrapHint: 'Paste cloud-init.yaml into the Launch script / user data area on instance creation.',
    summary: 'AWS-backed VPS option for users who want a simpler path than full EC2.',
  },
  gcp: {
    id: 'gcp',
    label: 'Google Cloud',
    shortLabel: 'GCP',
    bootstrapHint: 'Use an Ubuntu or Debian VM and provide cloud-init.yaml as startup metadata or cloud-init user data.',
    summary: 'Good option when you already use Google Cloud networking or IAM.',
  },
  azure: {
    id: 'azure',
    label: 'Azure',
    shortLabel: 'Azure',
    bootstrapHint: 'Paste cloud-init.yaml into Custom data / cloud-init when creating the VM.',
    summary: 'Useful for teams already standardized on Azure subscriptions and networking.',
  },
  oci: {
    id: 'oci',
    label: 'Oracle Cloud',
    shortLabel: 'OCI',
    bootstrapHint: 'Paste cloud-init.yaml into cloud-init user data when creating the instance.',
    summary: 'A practical low-cost VPS path if you already operate in Oracle Cloud.',
  },
  generic: {
    id: 'generic',
    label: 'Any Ubuntu VPS',
    shortLabel: 'Generic VPS',
    bootstrapHint: 'Use cloud-init.yaml on any Ubuntu 24.04 host with cloud-init, or copy bootstrap.sh after SSHing in.',
    summary: 'Generic fallback for bare metal, homelab servers, and providers not listed above.',
  },
}

const USE_CASE_META: Record<OpenClawUseCaseTemplate, UseCaseMeta> = {
  'local-dev': {
    id: 'local-dev',
    label: 'Local Dev',
    summary: 'Local-first OpenClaw control plane for testing and personal machines.',
    detail: 'Binds to loopback with safe defaults so a single developer can stand up OpenClaw quickly.',
    defaultExposure: 'private-lan',
    hostBind: '127.0.0.1',
    nodeOptions: null,
  },
  'single-vps': {
    id: 'single-vps',
    label: 'Single VPS',
    summary: 'Balanced always-on control plane for one server and a small swarm.',
    detail: 'Good default for Hetzner, DigitalOcean, Vultr, Linode, Lightsail, and generic Ubuntu VPS installs.',
    defaultExposure: 'caddy',
    hostBind: '0.0.0.0',
    nodeOptions: null,
  },
  'private-tailnet': {
    id: 'private-tailnet',
    label: 'Private Tailnet',
    summary: 'Keep the gateway off the public internet and expose it only through a trusted tailnet.',
    detail: 'Uses loopback binding and pairs well with Tailscale or an SSH tunnel.',
    defaultExposure: 'tailscale',
    hostBind: '127.0.0.1',
    nodeOptions: null,
  },
  'browser-heavy': {
    id: 'browser-heavy',
    label: 'Browser Heavy',
    summary: 'Higher-memory defaults for browser tools and long-running automation nodes.',
    detail: 'Raises Node memory limits and assumes a roomier VPS profile for browser-backed tasks.',
    defaultExposure: 'caddy',
    hostBind: '0.0.0.0',
    nodeOptions: '--max-old-space-size=3072',
  },
  'team-control': {
    id: 'team-control',
    label: 'Team Control',
    summary: 'Shared control plane defaults for a trusted team with backups and cleaner exposure choices.',
    detail: 'Prioritizes predictable exposure and easier operator handoff across a team.',
    defaultExposure: 'caddy',
    hostBind: '0.0.0.0',
    nodeOptions: '--max-old-space-size=2048',
  },
}

const EXPOSURE_META: Record<OpenClawExposurePreset, ExposureMeta> = {
  'private-lan': {
    id: 'private-lan',
    label: 'Private LAN',
    summary: 'Expose only on your LAN or through provider firewall rules.',
  },
  tailscale: {
    id: 'tailscale',
    label: 'Tailscale',
    summary: 'Keep OpenClaw on loopback and publish it only over your Tailscale tailnet.',
  },
  caddy: {
    id: 'caddy',
    label: 'Caddy',
    summary: 'Run a bundled reverse proxy that can terminate HTTPS and proxy the gateway safely.',
  },
  nginx: {
    id: 'nginx',
    label: 'Nginx',
    summary: 'Use an Nginx reverse proxy for teams that already manage TLS or edge certificates.',
  },
  'ssh-tunnel': {
    id: 'ssh-tunnel',
    label: 'SSH Tunnel',
    summary: 'Keep the gateway on loopback and access it through an SSH tunnel when needed.',
  },
}

function createLocalRuntimeState(
  id: string,
  patch?: Partial<LocalRuntimeState>,
): LocalRuntimeState {
  const port = typeof patch?.port === 'number' && Number.isFinite(patch.port)
    ? patch.port
    : DEFAULT_LOCAL_PORT
  const endpoint = normalizeOpenClawEndpoint(
    typeof patch?.endpoint === 'string' && patch.endpoint.trim()
      ? patch.endpoint
      : `http://127.0.0.1:${port}`,
  )
  return {
    id,
    name: typeof patch?.name === 'string' && patch.name.trim() ? patch.name.trim() : `Local OpenClaw ${port}`,
    processId: typeof patch?.processId === 'string' && patch.processId.trim() ? patch.processId.trim() : null,
    port,
    endpoint,
    wsUrl: typeof patch?.wsUrl === 'string' && patch.wsUrl.trim() ? patch.wsUrl.trim() : deriveOpenClawWsUrl(endpoint),
    token: typeof patch?.token === 'string' && patch.token.trim() ? patch.token.trim() : null,
    startedAt: typeof patch?.startedAt === 'number' ? patch.startedAt : null,
    createdAt: typeof patch?.createdAt === 'number' ? patch.createdAt : Date.now(),
    updatedAt: typeof patch?.updatedAt === 'number' ? patch.updatedAt : Date.now(),
    lastError: typeof patch?.lastError === 'string' && patch.lastError.trim() ? patch.lastError : null,
  }
}

function createRemoteRuntimeState(
  id: string,
  patch?: Partial<RemoteRuntimeState>,
): RemoteRuntimeState {
  const target = typeof patch?.target === 'string' && patch.target.trim() ? patch.target.trim() : null
  return {
    id,
    name: typeof patch?.name === 'string' && patch.name.trim()
      ? patch.name.trim()
      : deriveRemoteDeploymentName(target || ''),
    processId: typeof patch?.processId === 'string' && patch.processId.trim() ? patch.processId.trim() : null,
    action: typeof patch?.action === 'string' && patch.action.trim() ? patch.action.trim() : null,
    target,
    startedAt: typeof patch?.startedAt === 'number' ? patch.startedAt : null,
    createdAt: typeof patch?.createdAt === 'number' ? patch.createdAt : Date.now(),
    updatedAt: typeof patch?.updatedAt === 'number' ? patch.updatedAt : Date.now(),
    lastError: typeof patch?.lastError === 'string' && patch.lastError.trim() ? patch.lastError : null,
    lastSummary: typeof patch?.lastSummary === 'string' && patch.lastSummary.trim() ? patch.lastSummary : null,
    lastCommandPreview: typeof patch?.lastCommandPreview === 'string' && patch.lastCommandPreview.trim()
      ? patch.lastCommandPreview
      : null,
    lastBackupPath: typeof patch?.lastBackupPath === 'string' && patch.lastBackupPath.trim()
      ? patch.lastBackupPath
      : null,
  }
}

function resolveLocalRuntimePaths(id: string): LocalRuntimePaths {
  const safeId = id.trim() || 'local-default'
  const rootDir = path.join(DATA_DIR, 'openclaw-local', safeId)
  return {
    rootDir,
    stateDir: rootDir,
    configPath: path.join(rootDir, 'openclaw.json'),
    workspaceDir: path.join(rootDir, 'workspace'),
  }
}

function buildManagedLocalConfig(paths: LocalRuntimePaths): Record<string, unknown> {
  const config: Record<string, unknown> = {
    gateway: {
      mode: 'local',
      bind: 'custom',
      customBindHost: '127.0.0.1',
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
      },
    },
    agents: {
      defaults: {
        workspace: paths.workspaceDir,
      },
    },
  }

  if (process.env.OLLAMA_API_KEY?.trim()) {
    ;(config.agents as Record<string, Record<string, unknown>>).defaults.model = {
      primary: 'ollama/glm-5:cloud',
    }
    ;(config.agents as Record<string, Record<string, unknown>>).defaults.models = {
      'ollama/glm-5:cloud': {
        alias: 'glm5cloud',
      },
    }
  }

  return config
}

async function ensureManagedLocalRuntimeFiles(id: string): Promise<LocalRuntimePaths> {
  const paths = resolveLocalRuntimePaths(id)
  await fs.mkdir(paths.workspaceDir, { recursive: true })
  const config = buildManagedLocalConfig(paths)
  await fs.writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return paths
}

function buildLocalProcessEnv(id: string): Record<string, string> {
  const paths = resolveLocalRuntimePaths(id)
  return {
    OPENCLAW_CONFIG_PATH: paths.configPath,
    OPENCLAW_STATE_DIR: paths.stateDir,
  }
}

function normalizeLocalRuntimeState(raw: unknown, id: string): LocalRuntimeState | null {
  if (!raw || typeof raw !== 'object') return null
  return createLocalRuntimeState(id, raw as Partial<LocalRuntimeState>)
}

function normalizeRemoteRuntimeState(raw: unknown, id: string): RemoteRuntimeState | null {
  if (!raw || typeof raw !== 'object') return null
  return createRemoteRuntimeState(id, raw as Partial<RemoteRuntimeState>)
}

function sortLocalRuntimeStates(items: LocalRuntimeState[]): LocalRuntimeState[] {
  return [...items].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    if (left.port !== right.port) return left.port - right.port
    return left.id.localeCompare(right.id)
  })
}

function sortRemoteRuntimeStates(items: RemoteRuntimeState[]): RemoteRuntimeState[] {
  return [...items].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    const leftTarget = left.target || ''
    const rightTarget = right.target || ''
    if (leftTarget !== rightTarget) return leftTarget.localeCompare(rightTarget)
    return left.id.localeCompare(right.id)
  })
}

function defaultRuntimeState(): DeployRuntimeState {
  return {
    locals: {},
    primaryLocalId: null,
    remotes: {},
    primaryRemoteId: null,
  }
}

function normalizeRuntimeState(raw: unknown): DeployRuntimeState {
  const fallback = defaultRuntimeState()
  if (!raw || typeof raw !== 'object') return fallback
  const state = raw as Partial<DeployRuntimeState> & { local?: unknown; locals?: Record<string, unknown> }

  const locals: Record<string, LocalRuntimeState> = {}
  if (state.locals && typeof state.locals === 'object') {
    for (const [id, value] of Object.entries(state.locals)) {
      const normalized = normalizeLocalRuntimeState(value, id)
      if (normalized) locals[id] = normalized
    }
  } else if (state.local && typeof state.local === 'object') {
    const normalized = normalizeLocalRuntimeState(state.local, 'local-default')
    if (normalized) locals[normalized.id] = normalized
  }

  const orderedLocals = sortLocalRuntimeStates(Object.values(locals))
  const primaryLocalId = typeof state.primaryLocalId === 'string' && locals[state.primaryLocalId]
    ? state.primaryLocalId
    : orderedLocals[0]?.id || null

  const remotes: Record<string, RemoteRuntimeState> = {}
  const stateWithRemote = state as Partial<DeployRuntimeState> & {
    local?: unknown
    locals?: Record<string, unknown>
    remote?: unknown
    remotes?: Record<string, unknown>
    primaryRemoteId?: unknown
  }
  if (stateWithRemote.remotes && typeof stateWithRemote.remotes === 'object') {
    for (const [id, value] of Object.entries(stateWithRemote.remotes)) {
      const normalized = normalizeRemoteRuntimeState(value, id)
      if (normalized) remotes[id] = normalized
    }
  } else if (stateWithRemote.remote && typeof stateWithRemote.remote === 'object') {
    const normalized = normalizeRemoteRuntimeState(stateWithRemote.remote, 'remote-default')
    if (normalized) remotes[normalized.id] = normalized
  }
  const orderedRemotes = sortRemoteRuntimeStates(Object.values(remotes))
  const primaryRemoteId = typeof stateWithRemote.primaryRemoteId === 'string' && remotes[stateWithRemote.primaryRemoteId]
    ? stateWithRemote.primaryRemoteId
    : orderedRemotes[0]?.id || null

  return {
    locals,
    primaryLocalId,
    remotes,
    primaryRemoteId,
  }
}

function getRuntimeState(): DeployRuntimeState {
  const raw = hmrSingleton<DeployRuntimeState>(OC_DEPLOY_KEY, defaultRuntimeState)
  const normalized = normalizeRuntimeState(raw)
  // Write back the normalized state so subsequent reads see it
  ;(globalThis as Record<string, unknown>)[OC_DEPLOY_KEY] = normalized
  return normalized
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveBundledOpenClawBinary(): string {
  const binName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
  const candidates = [
    path.join(process.cwd(), 'node_modules', '.bin', binName),
    path.join(process.cwd(), '.next', 'standalone', 'node_modules', '.bin', binName),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'openclaw'
}

function buildLocalRunCommand(port: number, token?: string | null, localId = 'local-default'): string {
  const env = buildLocalProcessEnv(localId)
  const parts = [
    `OPENCLAW_CONFIG_PATH=${shellEscape(env.OPENCLAW_CONFIG_PATH)}`,
    `OPENCLAW_STATE_DIR=${shellEscape(env.OPENCLAW_STATE_DIR)}`,
    'npx',
    'openclaw',
    'gateway',
    'run',
    '--allow-unconfigured',
    '--force',
    '--bind',
    'custom',
    '--port',
    String(port),
  ]
  if (token) {
    parts.push('--auth', 'token', '--token', token)
  }
  return parts.join(' ')
}

function buildLocalInstallCommand(port: number, token?: string | null, localId = 'local-default'): string {
  const env = buildLocalProcessEnv(localId)
  const parts = [
    `OPENCLAW_CONFIG_PATH=${shellEscape(env.OPENCLAW_CONFIG_PATH)}`,
    `OPENCLAW_STATE_DIR=${shellEscape(env.OPENCLAW_STATE_DIR)}`,
    'npx',
    'openclaw',
    'gateway',
    'install',
    '--port',
    String(port),
  ]
  if (token) parts.push('--token', token)
  return `${parts.join(' ')} && npx openclaw gateway start`
}

function sanitizePort(value: unknown, fallback = DEFAULT_LOCAL_PORT): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1024, Math.min(65535, Math.trunc(parsed)))
}

function normalizeToken(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeRemoteProvider(value: unknown): OpenClawRemoteDeployProvider {
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
  return 'hetzner'
}

function normalizeUseCase(value: unknown): OpenClawUseCaseTemplate {
  if (
    value === 'local-dev'
    || value === 'single-vps'
    || value === 'private-tailnet'
    || value === 'browser-heavy'
    || value === 'team-control'
  ) {
    return value
  }
  return 'single-vps'
}

function normalizeExposurePreset(value: unknown, fallback?: OpenClawUseCaseTemplate): OpenClawExposurePreset {
  if (
    value === 'private-lan'
    || value === 'tailscale'
    || value === 'caddy'
    || value === 'nginx'
    || value === 'ssh-tunnel'
  ) {
    return value
  }
  const useCase = fallback ? USE_CASE_META[fallback] : null
  return useCase?.defaultExposure || 'private-lan'
}

function sanitizeSshConfig(input?: Partial<OpenClawSshConfig> | null): OpenClawSshConfig | null {
  const host = typeof input?.host === 'string' && input.host.trim() ? input.host.trim() : ''
  if (!host) return null
  const port = sanitizePort(input?.port, 22)
  return {
    host,
    user: typeof input?.user === 'string' && input.user.trim() ? input.user.trim() : 'root',
    port,
    keyPath: typeof input?.keyPath === 'string' && input.keyPath.trim() ? input.keyPath.trim() : null,
    targetDir: typeof input?.targetDir === 'string' && input.targetDir.trim() ? input.targetDir.trim() : '/opt/openclaw',
  }
}

function buildSshTarget(config: OpenClawSshConfig): string {
  return `${config.user || 'root'}@${config.host}`
}

function buildSshArgs(config: OpenClawSshConfig, forScp = false): string[] {
  const args: string[] = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']
  if (config.keyPath) args.push('-i', config.keyPath)
  args.push(forScp ? '-P' : '-p', String(config.port || 22))
  return args
}

async function materializeBundleFiles(bundle: OpenClawDeployBundle): Promise<{ dir: string; filePaths: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarmclaw-openclaw-'))
  const filePaths: string[] = []
  for (const file of bundle.files) {
    const filePath = path.join(dir, file.name)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, file.content, 'utf8')
    filePaths.push(filePath)
  }
  return { dir, filePaths }
}

async function startRemoteCommand(params: {
  remoteId?: string | null
  name?: string | null
  action: string
  target: string
  command: string
  summary: string
  backupPath?: string | null
  makePrimary?: boolean
}): Promise<OpenClawRemoteCommandResult> {
  const state = getRuntimeState()
  const requestedRemoteId = typeof params.remoteId === 'string' && params.remoteId.trim()
    ? params.remoteId.trim()
    : null
  const existingById = requestedRemoteId ? state.remotes[requestedRemoteId] || null : null
  const existingByTarget = Object.values(state.remotes).find((item) => (
    normalizeRemoteTargetKey(item.target) === normalizeRemoteTargetKey(params.target)
  )) || null
  const remoteId = existingById?.id || existingByTarget?.id || requestedRemoteId || generateRemoteDeployId()
  const existing = existingById || existingByTarget || null
  const current = existing || createRemoteRuntimeState(remoteId, {
    name: params.name || deriveRemoteDeploymentName(params.target),
    target: params.target,
  })

  if (current.processId) {
    const currentProcess = getManagedProcess(current.processId)
    if (currentProcess?.status === 'running') {
      killManagedProcess(current.processId)
    }
    removeManagedProcess(current.processId)
  }

  const result = await startManagedProcess({
    command: params.command,
    cwd: process.cwd(),
    background: true,
    timeoutMs: 30 * 60_000,
  })

  if (result.status === 'completed' && (result.exitCode ?? 0) === 0) {
    state.remotes[remoteId] = createRemoteRuntimeState(remoteId, {
      ...current,
      name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : current.name,
      processId: null,
      action: params.action,
      target: params.target,
      startedAt: null,
      updatedAt: Date.now(),
      lastError: null,
      lastSummary: params.summary,
      lastCommandPreview: params.command,
      lastBackupPath: params.backupPath || null,
    })
    if (params.makePrimary !== false || !state.primaryRemoteId) state.primaryRemoteId = remoteId
    return {
      ok: true,
      started: false,
      remoteId,
      processId: null,
      summary: params.summary,
      commandPreview: params.command,
    }
  }

  if (result.status !== 'running') {
    const message = result.output || result.tail || params.summary
    state.remotes[remoteId] = createRemoteRuntimeState(remoteId, {
      ...current,
      name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : current.name,
      processId: null,
      action: params.action,
      target: params.target,
      startedAt: null,
      updatedAt: Date.now(),
      lastError: message,
      lastSummary: params.summary,
      lastCommandPreview: params.command,
      lastBackupPath: params.backupPath || null,
    })
    if (params.makePrimary !== false || !state.primaryRemoteId) state.primaryRemoteId = remoteId
    return {
      ok: false,
      started: false,
      remoteId,
      processId: null,
      summary: message,
      commandPreview: params.command,
    }
  }

  state.remotes[remoteId] = createRemoteRuntimeState(remoteId, {
    ...current,
    name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : current.name,
    processId: result.processId,
    action: params.action,
    target: params.target,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
    lastSummary: params.summary,
    lastCommandPreview: params.command,
    lastBackupPath: params.backupPath || null,
  })
  if (params.makePrimary !== false || !state.primaryRemoteId) state.primaryRemoteId = remoteId
  return {
    ok: true,
    started: true,
    remoteId,
    processId: result.processId,
    summary: params.summary,
    commandPreview: params.command,
  }
}


async function waitForLocalRuntime(processId: string, attempts = 12): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const process = getManagedProcess(processId)
    if (!process || process.status !== 'running') break
    if ((process.log || '').toLowerCase().includes('listening')) return
    await sleep(500)
  }
}

function readTail(text: string, size = 1200): string {
  if (!text) return ''
  return text.length <= size ? text : text.slice(text.length - size)
}

function currentLocalStatusFromState(localState: LocalRuntimeState, isPrimary: boolean): OpenClawLocalDeployStatus {
  const state = getRuntimeState()
  const runtime = state.locals[localState.id] || localState
  const paths = resolveLocalRuntimePaths(runtime.id)
  const processId = runtime.processId
  const process = processId ? getManagedProcess(processId) : null
  const running = !!process && process.status === 'running'

  if (!running && processId && process && process.status !== 'running') {
    runtime.lastError = readTail(process.log || '') || runtime.lastError
    runtime.processId = null
    runtime.startedAt = null
    runtime.updatedAt = Date.now()
    state.locals[runtime.id] = runtime
  }

  const endpoint = normalizeOpenClawEndpoint(`http://127.0.0.1:${runtime.port}`)
  return {
    id: runtime.id,
    name: runtime.name || `Local OpenClaw ${runtime.port}`,
    isPrimary,
    running,
    processId: running ? processId : null,
    pid: running ? (process?.pid ?? null) : null,
    port: runtime.port,
    endpoint,
    wsUrl: deriveOpenClawWsUrl(endpoint),
    token: runtime.token || null,
    stateDir: paths.stateDir,
    configPath: paths.configPath,
    workspaceDir: paths.workspaceDir,
    startedAt: running ? runtime.startedAt : null,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    tail: process ? readTail(process.log || '') : '',
    lastError: running ? null : (runtime.lastError || null),
    launchCommand: buildLocalRunCommand(runtime.port, runtime.token, runtime.id),
    installCommand: buildLocalInstallCommand(runtime.port, runtime.token, runtime.id),
  }
}

function getPrimaryLocalRuntimeState(state: DeployRuntimeState): LocalRuntimeState | null {
  if (state.primaryLocalId && state.locals[state.primaryLocalId]) {
    return state.locals[state.primaryLocalId]
  }
  const ordered = sortLocalRuntimeStates(Object.values(state.locals))
  const next = ordered[0] || null
  state.primaryLocalId = next?.id || null
  return next
}

function findLocalRuntimeState(
  state: DeployRuntimeState,
  input?: { localId?: string | null; port?: number | null },
): LocalRuntimeState | null {
  const localId = typeof input?.localId === 'string' && input.localId.trim() ? input.localId.trim() : ''
  if (localId && state.locals[localId]) return state.locals[localId]
  const port = typeof input?.port === 'number' && Number.isFinite(input.port) ? input.port : null
  if (port !== null) {
    return Object.values(state.locals).find((item) => item.port === port) || null
  }
  return getPrimaryLocalRuntimeState(state)
}

function defaultLocalStatus(): OpenClawLocalDeployStatus {
  const fallback = createLocalRuntimeState('local-default')
  return currentLocalStatusFromState(fallback, true)
}

export function getOpenClawLocalDeployStatuses(): OpenClawLocalDeployStatus[] {
  const state = getRuntimeState()
  return sortLocalRuntimeStates(Object.values(state.locals))
    .map((runtime) => currentLocalStatusFromState(runtime, runtime.id === state.primaryLocalId))
}

export function getOpenClawLocalDeployCollectionStatus(): OpenClawLocalDeployCollectionStatus {
  const state = getRuntimeState()
  const items = getOpenClawLocalDeployStatuses()
  const primaryId = items.find((item) => item.isPrimary)?.id || null
  state.primaryLocalId = primaryId
  return { primaryId, items }
}

export function getOpenClawLocalDeployStatus(localId?: string | null): OpenClawLocalDeployStatus {
  const state = getRuntimeState()
  const runtime = findLocalRuntimeState(state, { localId })
  return runtime
    ? currentLocalStatusFromState(runtime, runtime.id === state.primaryLocalId)
    : defaultLocalStatus()
}

function currentRemoteStatusFromState(remoteState: RemoteRuntimeState, isPrimary: boolean): OpenClawRemoteDeployStatus {
  const state = getRuntimeState()
  const runtime = state.remotes[remoteState.id] || remoteState
  const processId = runtime.processId
  const process = processId ? getManagedProcess(processId) : null
  const active = !!process && process.status === 'running'

  if (!active && processId && process && process.status !== 'running') {
    runtime.lastError = readTail(process.log || '') || runtime.lastError
    runtime.processId = null
    runtime.startedAt = null
    runtime.updatedAt = Date.now()
    state.remotes[runtime.id] = runtime
  }

  return {
    id: runtime.id,
    name: runtime.name || deriveRemoteDeploymentName(runtime.target || ''),
    isPrimary,
    active,
    processId: active ? processId : null,
    pid: active ? (process?.pid ?? null) : null,
    action: runtime.action || null,
    target: runtime.target || null,
    startedAt: runtime.startedAt || null,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    status: process?.status || 'idle',
    exitCode: process?.exitCode ?? null,
    tail: process ? readTail(process.log || '') : '',
    lastError: active ? null : (runtime.lastError || null),
    lastSummary: runtime.lastSummary || null,
    lastCommandPreview: runtime.lastCommandPreview || null,
    lastBackupPath: runtime.lastBackupPath || null,
  }
}

function getPrimaryRemoteRuntimeState(state: DeployRuntimeState): RemoteRuntimeState | null {
  if (state.primaryRemoteId && state.remotes[state.primaryRemoteId]) {
    return state.remotes[state.primaryRemoteId]
  }
  const ordered = sortRemoteRuntimeStates(Object.values(state.remotes))
  const next = ordered[0] || null
  state.primaryRemoteId = next?.id || null
  return next
}

function normalizeRemoteTargetKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function findRemoteRuntimeState(
  state: DeployRuntimeState,
  input?: { remoteId?: string | null; target?: string | null },
): RemoteRuntimeState | null {
  const remoteId = typeof input?.remoteId === 'string' && input.remoteId.trim() ? input.remoteId.trim() : ''
  if (remoteId && state.remotes[remoteId]) return state.remotes[remoteId]
  const targetKey = normalizeRemoteTargetKey(input?.target)
  if (targetKey) {
    return Object.values(state.remotes).find((item) => normalizeRemoteTargetKey(item.target) === targetKey) || null
  }
  return getPrimaryRemoteRuntimeState(state)
}

function defaultRemoteStatus(): OpenClawRemoteDeployStatus {
  const fallback = createRemoteRuntimeState('remote-default', { name: 'Remote OpenClaw' })
  return currentRemoteStatusFromState(fallback, true)
}

export function getOpenClawRemoteDeployStatuses(): OpenClawRemoteDeployStatus[] {
  const state = getRuntimeState()
  return sortRemoteRuntimeStates(Object.values(state.remotes))
    .map((runtime) => currentRemoteStatusFromState(runtime, runtime.id === state.primaryRemoteId))
}

export function getOpenClawRemoteDeployCollectionStatus(): OpenClawRemoteDeployCollectionStatus {
  const state = getRuntimeState()
  const items = getOpenClawRemoteDeployStatuses()
  const primaryId = items.find((item) => item.isPrimary)?.id || null
  state.primaryRemoteId = primaryId
  return { primaryId, items }
}

export function getOpenClawRemoteDeployStatus(remoteId?: string | null): OpenClawRemoteDeployStatus {
  const state = getRuntimeState()
  const runtime = findRemoteRuntimeState(state, { remoteId })
  return runtime
    ? currentRemoteStatusFromState(runtime, runtime.id === state.primaryRemoteId)
    : defaultRemoteStatus()
}

export function generateOpenClawGatewayToken(): string {
  return randomBytes(24).toString('base64url')
}

function generateLocalDeployId(): string {
  return `local-${randomBytes(8).toString('hex')}`
}

function generateRemoteDeployId(): string {
  return `remote-${randomBytes(8).toString('hex')}`
}

export async function startOpenClawLocalDeploy(input?: {
  localId?: string | null
  name?: string | null
  port?: number
  token?: string | null
  makePrimary?: boolean
}): Promise<{ local: OpenClawLocalDeployStatus; locals: OpenClawLocalDeployStatus[]; token: string }> {
  const state = getRuntimeState()
  const port = sanitizePort(input?.port, DEFAULT_LOCAL_PORT)
  const requestedLocalId = typeof input?.localId === 'string' && input.localId.trim()
    ? input.localId.trim()
    : null
  const existingById = requestedLocalId ? state.locals[requestedLocalId] || null : null
  const existingByPort = Object.values(state.locals).find((item) => item.port === port) || null
  const localId = existingById?.id || existingByPort?.id || requestedLocalId || generateLocalDeployId()
  const existing = existingById || existingByPort || null
  const current = existing || createLocalRuntimeState(localId, {
    port,
    name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : `Local OpenClaw ${port}`,
  })

  if (existingByPort && existingByPort.id !== localId && existingByPort.processId) {
    const conflictProcess = getManagedProcess(existingByPort.processId)
    if (conflictProcess?.status === 'running') {
      killManagedProcess(existingByPort.processId)
    }
    removeManagedProcess(existingByPort.processId)
    existingByPort.processId = null
    existingByPort.startedAt = null
    existingByPort.updatedAt = Date.now()
    state.locals[existingByPort.id] = existingByPort
  }

  if (current.processId) {
    const currentProcess = getManagedProcess(current.processId)
    if (currentProcess?.status === 'running') {
      killManagedProcess(current.processId)
    }
    removeManagedProcess(current.processId)
  }

  const token = normalizeToken(input?.token) || generateOpenClawGatewayToken()
  const endpoint = normalizeOpenClawEndpoint(`http://127.0.0.1:${port}`)
  const wsUrl = deriveOpenClawWsUrl(endpoint)
  await ensureManagedLocalRuntimeFiles(localId)
  const binary = resolveBundledOpenClawBinary()
  const args = [
    binary,
    'gateway',
    'run',
    '--allow-unconfigured',
    '--force',
    '--bind',
    'custom',
    '--port',
    String(port),
    '--auth',
    'token',
    '--token',
    token,
    '--verbose',
  ]

  const result = await startManagedProcess({
    command: args.map(shellEscape).join(' '),
    cwd: process.cwd(),
    env: buildLocalProcessEnv(localId),
    background: true,
    timeoutMs: 24 * 60 * 60_000,
  })

  if (result.status !== 'running') {
    const message = result.output || result.tail || 'OpenClaw failed to start.'
    state.locals[localId] = createLocalRuntimeState(localId, {
      ...current,
      name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : current.name,
      processId: null,
      port,
      endpoint,
      wsUrl,
      token,
      startedAt: null,
      updatedAt: Date.now(),
      lastError: message,
    })
    if (input?.makePrimary !== false || !state.primaryLocalId) state.primaryLocalId = localId
    throw new Error(message)
  }

  state.locals[localId] = createLocalRuntimeState(localId, {
    ...current,
    name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : current.name,
    processId: result.processId,
    port,
    endpoint,
    wsUrl,
    token,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  })
  if (input?.makePrimary !== false || !state.primaryLocalId) state.primaryLocalId = localId

  await waitForLocalRuntime(result.processId)

  const local = getOpenClawLocalDeployStatus(localId)
  return {
    local,
    locals: getOpenClawLocalDeployStatuses(),
    token,
  }
}

export function stopOpenClawLocalDeploy(localId?: string | null): { local: OpenClawLocalDeployStatus; locals: OpenClawLocalDeployStatus[] } {
  const state = getRuntimeState()
  const runtime = findLocalRuntimeState(state, { localId })
  if (!runtime) {
    const local = defaultLocalStatus()
    return { local, locals: getOpenClawLocalDeployStatuses() }
  }

  const processId = runtime.processId
  if (processId) {
    const process = getManagedProcess(processId)
    if (process?.status === 'running') {
      killManagedProcess(processId)
    }
    removeManagedProcess(processId)
  }
  runtime.processId = null
  runtime.startedAt = null
  runtime.updatedAt = Date.now()
  state.locals[runtime.id] = runtime
  if (state.primaryLocalId === runtime.id) {
    state.primaryLocalId = sortLocalRuntimeStates(Object.values(state.locals).filter((item) => item.id !== runtime.id && item.processId))
      [0]?.id
      || runtime.id
  }
  return {
    local: getOpenClawLocalDeployStatus(runtime.id),
    locals: getOpenClawLocalDeployStatuses(),
  }
}

export async function restartOpenClawLocalDeploy(input?: {
  localId?: string | null
  name?: string | null
  port?: number
  token?: string | null
  makePrimary?: boolean
}): Promise<{ local: OpenClawLocalDeployStatus; locals: OpenClawLocalDeployStatus[]; token: string }> {
  const state = getRuntimeState()
  const current = findLocalRuntimeState(state, {
    localId: input?.localId ?? null,
    port: typeof input?.port === 'number' ? input.port : null,
  })
  return startOpenClawLocalDeploy({
    localId: input?.localId ?? current?.id ?? null,
    name: input?.name ?? current?.name ?? null,
    port: input?.port ?? current?.port ?? DEFAULT_LOCAL_PORT,
    token: input?.token ?? current?.token ?? null,
    makePrimary: input?.makePrimary,
  })
}

function ensureSchemeAndPort(raw: string, scheme: 'http' | 'https', port: number): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return `${scheme}://127.0.0.1:${port}`
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  const defaultPort = scheme === 'https' ? 443 : port
  const hasPort = /:\d+$/.test(trimmed)
  const portSuffix = hasPort || defaultPort === 443 ? '' : `:${defaultPort}`
  return `${scheme}://${trimmed}${portSuffix}`
}

function deriveRemoteDeploymentName(target: string): string {
  const cleaned = target
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .trim()
  return cleaned || 'Remote OpenClaw'
}

function indentBlock(value: string, spaces: number): string {
  const padding = ' '.repeat(spaces)
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `${padding}${line}`)
    .join('\n')
}

interface DockerBundleOptions {
  token: string
  endpointHost: string
  useCase: OpenClawUseCaseTemplate
  exposure: OpenClawExposurePreset
}

function resolveHostBindAddress(useCase: OpenClawUseCaseTemplate, exposure: OpenClawExposurePreset): string {
  if (exposure === 'tailscale' || exposure === 'ssh-tunnel' || exposure === 'caddy' || exposure === 'nginx') {
    return '127.0.0.1'
  }
  return USE_CASE_META[useCase].hostBind
}

function buildDockerComposeFile(options: DockerBundleOptions): string {
  return `services:
  openclaw-gateway:
    image: \${OPENCLAW_IMAGE:-openclaw:latest}
    environment:
      HOME: /home/node
      TERM: xterm-256color
      NODE_OPTIONS: \${OPENCLAW_NODE_OPTIONS:-}
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      OPENCLAW_GATEWAY_BIND: \${OPENCLAW_GATEWAY_BIND:-lan}
    volumes:
      - \${OPENCLAW_CONFIG_DIR:-./.openclaw}:/home/node/.openclaw
      - \${OPENCLAW_WORKSPACE_DIR:-./workspace}:/home/node/.openclaw/workspace
    ports:
      - "\${OPENCLAW_HOST_BIND:-${resolveHostBindAddress(options.useCase, options.exposure)}}:\${OPENCLAW_GATEWAY_PORT:-18789}:18789"
      - "\${OPENCLAW_HOST_BIND:-${resolveHostBindAddress(options.useCase, options.exposure)}}:\${OPENCLAW_BRIDGE_PORT:-18790}:18790"
    init: true
    restart: unless-stopped
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "\${OPENCLAW_GATEWAY_BIND:-lan}",
        "--port",
        "18789",
        "--auth",
        "token",
        "--token",
        "\${OPENCLAW_GATEWAY_TOKEN}",
      ]
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
`
}

function buildDockerEnvFile(options: DockerBundleOptions): string {
  return `OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=${options.token}
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_HOST_BIND=${resolveHostBindAddress(options.useCase, options.exposure)}
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_CONFIG_DIR=./.openclaw
OPENCLAW_WORKSPACE_DIR=./workspace
OPENCLAW_USE_CASE=${options.useCase}
OPENCLAW_EXPOSURE=${options.exposure}
OPENCLAW_NODE_OPTIONS=${USE_CASE_META[options.useCase].nodeOptions || ''}
`
}

function buildDockerBootstrapScript(options: DockerBundleOptions): string {
  return `#!/usr/bin/env bash
set -euo pipefail

APP_DIR="\${OPENCLAW_APP_DIR:-$HOME/openclaw}"

mkdir -p "$APP_DIR"
cd "$APP_DIR"
mkdir -p .openclaw workspace backups

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. On Ubuntu 24.04 you can install it with:"
  echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin"
  exit 1
fi

docker pull "\${OPENCLAW_IMAGE:-openclaw:latest}"
docker compose up -d
if [ -f docker-compose.proxy.yml ]; then
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
fi
docker compose ps
echo "Use case: ${options.useCase}"
echo "Exposure preset: ${options.exposure}"
`
}

function buildCloudInitFile(options: DockerBundleOptions): string {
  const envFile = buildDockerEnvFile(options)
  const composeFile = buildDockerComposeFile(options)
  const bootstrapFile = buildDockerBootstrapScript(options)
  const extraFiles = buildExposureFiles(options)
    .filter((file) => !['.env', 'docker-compose.yml', 'bootstrap.sh'].includes(file.name))
    .map((file) => `  - path: /opt/openclaw/${file.name}
    owner: root:root
    permissions: "${file.name.endsWith('.sh') ? '0755' : '0644'}"
    content: |
${indentBlock(file.content, 6)}`)
    .join('\n')
  return `#cloud-config
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - docker.io
  - docker-compose-plugin
write_files:
  - path: /opt/openclaw/.env
    owner: root:root
    permissions: "0600"
    content: |
${indentBlock(envFile, 6)}
  - path: /opt/openclaw/docker-compose.yml
    owner: root:root
    permissions: "0644"
    content: |
${indentBlock(composeFile, 6)}
  - path: /opt/openclaw/bootstrap.sh
    owner: root:root
    permissions: "0755"
    content: |
${indentBlock(bootstrapFile, 6)}
${extraFiles ? `${extraFiles}
` : ''}runcmd:
  - mkdir -p /opt/openclaw/.openclaw /opt/openclaw/workspace /opt/openclaw/backups
  - systemctl enable --now docker
  - bash -lc 'cd /opt/openclaw && docker pull "\${OPENCLAW_IMAGE:-openclaw:latest}"'
  - bash -lc 'cd /opt/openclaw && docker compose up -d'
  - bash -lc 'cd /opt/openclaw && if [ -f docker-compose.proxy.yml ]; then docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d; fi'
final_message: "OpenClaw gateway bootstrap complete. Run: sudo docker compose -f /opt/openclaw/docker-compose.yml ps"
`
}

function buildCaddyComposeFile(): string {
  return `services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - openclaw-gateway
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
`
}

function buildCaddyfile(endpointHost: string): string {
  return `${endpointHost} {
  encode gzip
  reverse_proxy openclaw-gateway:18789
}
`
}

function buildNginxComposeFile(): string {
  return `services:
  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    depends_on:
      - openclaw-gateway
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
`
}

function buildNginxConfig(endpointHost: string): string {
  return `server {
  listen 80;
  server_name ${endpointHost};

  location / {
    proxy_pass http://openclaw-gateway:18789;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
`
}

function buildTailscaleServeScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

PORT="\${OPENCLAW_GATEWAY_PORT:-18789}"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Install Tailscale first: https://tailscale.com/download"
  exit 1
fi

sudo tailscale serve --bg --set-path=/ http://127.0.0.1:$PORT
tailscale status
`
}

function buildSshTunnelGuide(endpointHost: string): string {
  return `Use an SSH tunnel instead of opening the gateway publicly.

Example:
  ssh -N -L 18789:127.0.0.1:18789 user@${endpointHost}

Then point SwarmClaw at:
  http://127.0.0.1:18789/v1
`
}

function buildExposureFiles(options: DockerBundleOptions): OpenClawDeployBundleFile[] {
  if (options.exposure === 'caddy') {
    return [
      { name: 'docker-compose.proxy.yml', language: 'yaml', content: buildCaddyComposeFile() },
      { name: 'Caddyfile', language: 'text', content: buildCaddyfile(options.endpointHost) },
    ]
  }
  if (options.exposure === 'nginx') {
    return [
      { name: 'docker-compose.proxy.yml', language: 'yaml', content: buildNginxComposeFile() },
      { name: 'nginx.conf', language: 'text', content: buildNginxConfig(options.endpointHost) },
    ]
  }
  if (options.exposure === 'tailscale') {
    return [{ name: 'tailscale-serve.sh', language: 'bash', content: buildTailscaleServeScript() }]
  }
  if (options.exposure === 'ssh-tunnel') {
    return [{ name: 'ssh-tunnel.txt', language: 'text', content: buildSshTunnelGuide(options.endpointHost) }]
  }
  return []
}

function buildRenderManifest(): string {
  return `services:
  - type: web
    name: openclaw
    runtime: docker
    plan: starter
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: "8080"
      - key: SETUP_PASSWORD
        sync: false
      - key: OPENCLAW_STATE_DIR
        value: /data/.openclaw
      - key: OPENCLAW_WORKSPACE_DIR
        value: /data/workspace
      - key: OPENCLAW_GATEWAY_TOKEN
        sync: false
    disk:
      name: openclaw-data
      mountPath: /data
      sizeGB: 1
`
}

function buildFlyToml(): string {
  return `app = "openclaw"
primary_region = "iad"

[build]
dockerfile = "Dockerfile"

[env]
NODE_ENV = "production"
OPENCLAW_PREFER_PNPM = "1"
OPENCLAW_STATE_DIR = "/data"
NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
internal_port = 3000
force_https = true
auto_stop_machines = false
auto_start_machines = true
min_machines_running = 1
processes = ["app"]

[[vm]]
size = "shared-cpu-2x"
memory = "2048mb"

[mounts]
source = "openclaw_data"
destination = "/data"
`
}

function buildRailwayEnvTemplate(token: string): string {
  return `OPENCLAW_GATEWAY_TOKEN=${token}
OPENCLAW_STATE_DIR=/data/.openclaw
OPENCLAW_WORKSPACE_DIR=/data/workspace
PORT=8080
`
}

function buildRailwayConfig(): string {
  return `{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "healthcheckPath": "/healthz",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
`
}

function buildDockerRunbook(
  providerMeta: RemoteProviderMeta,
  endpoint: string,
  useCase: OpenClawUseCaseTemplate,
  exposure: OpenClawExposurePreset,
): string[] {
  const endpointHost = deriveRemoteDeploymentName(endpoint)
  return [
    `Provision a small Ubuntu 24.04 server on ${providerMeta.label}. ${providerMeta.bootstrapHint}`,
    `Use case preset: ${USE_CASE_META[useCase].label}. Exposure preset: ${EXPOSURE_META[exposure].label}.`,
    'Let first boot finish, then confirm the service with: sudo docker compose -f /opt/openclaw/docker-compose.yml ps',
    exposure === 'tailscale'
      ? 'Run tailscale-serve.sh after the host joins your tailnet so OpenClaw stays private.'
      : exposure === 'caddy'
        ? 'Set your DNS name to this host and start the bundled Caddy proxy for HTTPS termination.'
        : exposure === 'nginx'
          ? 'Start the bundled Nginx proxy or bring your own TLS terminator in front of the gateway.'
          : exposure === 'ssh-tunnel'
            ? 'Do not expose the gateway publicly; use the generated SSH tunnel guide instead.'
            : `Point a DNS name, reverse proxy, or private network hostname at ${endpointHost} and keep the generated token private.`,
    'Use the generated endpoint and token in SwarmClaw to save the gateway profile.',
  ]
}

export function buildOpenClawDeployBundle(input?: {
  template?: OpenClawRemoteDeployTemplate
  target?: string | null
  token?: string | null
  scheme?: 'http' | 'https'
  port?: number
  provider?: OpenClawRemoteDeployProvider
  useCase?: OpenClawUseCaseTemplate
  exposure?: OpenClawExposurePreset
}): OpenClawDeployBundle {
  const template = input?.template || 'docker'
  const token = normalizeToken(input?.token) || generateOpenClawGatewayToken()
  const scheme = input?.scheme === 'http' ? 'http' : 'https'
  const port = sanitizePort(input?.port, DEFAULT_REMOTE_PORT)
  const rawTarget = typeof input?.target === 'string' ? input.target.trim() : ''
  const endpoint = normalizeOpenClawEndpoint(ensureSchemeAndPort(rawTarget || 'openclaw.example.com', scheme, port))
  const wsUrl = deriveOpenClawWsUrl(endpoint)
  const provider = normalizeRemoteProvider(input?.provider)
  const providerMeta = REMOTE_PROVIDER_META[provider]
  const useCase = normalizeUseCase(input?.useCase)
  const exposure = normalizeExposurePreset(input?.exposure, useCase)
  const bundleOptions: DockerBundleOptions = {
    token,
    endpointHost: deriveRemoteDeploymentName(endpoint),
    useCase,
    exposure,
  }

  if (template === 'render') {
    return {
      template,
      provider: 'generic',
      providerLabel: 'Render',
      useCase,
      exposure,
      title: 'Render OpenClaw Service',
      summary: 'Deploy the official OpenClaw repo as a Docker web service on Render, then point SwarmClaw at the public HTTPS URL.',
      endpoint,
      wsUrl,
      token,
      runbook: [
        'Create a new Render Web Service from the official OpenClaw GitHub repo.',
        'Add OPENCLAW_GATEWAY_TOKEN as a secret environment variable using the generated token below.',
        'After the service is live, paste the HTTPS URL back into SwarmClaw and save this gateway.',
      ],
      files: [
        { name: 'render.yaml', language: 'yaml', content: buildRenderManifest() },
        { name: 'OPENCLAW_GATEWAY_TOKEN.txt', language: 'text', content: token },
      ],
    }
  }

  if (template === 'fly') {
    return {
      template,
      provider: 'generic',
      providerLabel: 'Fly.io',
      useCase,
      exposure,
      title: 'Fly.io OpenClaw App',
      summary: 'Deploy the official OpenClaw repo on Fly.io for an always-on remote gateway with a persistent volume and HTTPS out of the box.',
      endpoint,
      wsUrl,
      token,
      runbook: [
        'Deploy the official OpenClaw repo with this fly.toml.',
        'Set OPENCLAW_GATEWAY_TOKEN as a Fly secret before first deploy.',
        'Use the resulting HTTPS app URL as your SwarmClaw OpenClaw endpoint.',
      ],
      files: [
        { name: 'fly.toml', language: 'toml', content: buildFlyToml() },
        { name: 'OPENCLAW_GATEWAY_TOKEN.txt', language: 'text', content: token },
      ],
    }
  }

  if (template === 'railway') {
    return {
      template,
      provider: 'generic',
      providerLabel: 'Railway',
      useCase,
      exposure,
      title: 'Railway OpenClaw Service',
      summary: 'Deploy the official OpenClaw repo on Railway using its Dockerfile, then attach a volume and set the generated gateway token.',
      endpoint,
      wsUrl,
      token,
      runbook: [
        'Create a Railway project from the official OpenClaw GitHub repo so Railway builds the root Dockerfile automatically.',
        'Attach a persistent volume at /data, then paste the generated variables below into the service variables editor.',
        'After Railway deploys, use the public HTTPS URL as your SwarmClaw OpenClaw endpoint.',
      ],
      files: [
        { name: 'railway.json', language: 'text', content: buildRailwayConfig() },
        { name: 'railway.env', language: 'env', content: buildRailwayEnvTemplate(token) },
      ],
    }
  }

  return {
    template: 'docker',
    provider,
    providerLabel: providerMeta.shortLabel,
    useCase,
    exposure,
    title: `${providerMeta.shortLabel} OpenClaw Smart Deploy`,
    summary: `${providerMeta.summary} ${USE_CASE_META[useCase].detail} This bundle only uses the official OpenClaw Docker image and gives you both manual Docker files and a cloud-init quickstart.`,
    endpoint,
    wsUrl,
    token,
    runbook: buildDockerRunbook(providerMeta, endpoint, useCase, exposure),
    files: [
      { name: 'cloud-init.yaml', language: 'yaml', content: buildCloudInitFile(bundleOptions) },
      { name: '.env', language: 'env', content: buildDockerEnvFile(bundleOptions) },
      { name: 'docker-compose.yml', language: 'yaml', content: buildDockerComposeFile(bundleOptions) },
      { name: 'bootstrap.sh', language: 'bash', content: buildDockerBootstrapScript(bundleOptions) },
      ...buildExposureFiles(bundleOptions),
    ],
  }
}

function buildSshInvocation(config: OpenClawSshConfig, remoteCommand: string): string {
  return ['ssh', ...buildSshArgs(config), buildSshTarget(config), remoteCommand]
    .map(shellEscape)
    .join(' ')
}

function buildScpInvocation(config: OpenClawSshConfig, filePaths: string[]): string {
  const destination = `${buildSshTarget(config)}:${config.targetDir || '/opt/openclaw'}/`
  return ['scp', ...buildSshArgs(config, true), ...filePaths, destination]
    .map(shellEscape)
    .join(' ')
}

export async function verifyOpenClawDeployment(input?: {
  endpoint?: string | null
  credentialId?: string | null
  token?: string | null
  model?: string | null
  timeoutMs?: number
}): Promise<OpenClawHealthResult> {
  return probeOpenClawHealth({
    endpoint: input?.endpoint || null,
    credentialId: input?.credentialId || null,
    token: input?.token || null,
    model: input?.model || null,
    timeoutMs: input?.timeoutMs,
  })
}

export async function deployOpenClawBundleOverSsh(input?: {
  remoteId?: string | null
  name?: string | null
  template?: OpenClawRemoteDeployTemplate
  target?: string | null
  token?: string | null
  scheme?: 'http' | 'https'
  port?: number
  provider?: OpenClawRemoteDeployProvider
  useCase?: OpenClawUseCaseTemplate
  exposure?: OpenClawExposurePreset
  ssh?: Partial<OpenClawSshConfig> | null
  makePrimary?: boolean
}): Promise<OpenClawRemoteCommandResult> {
  const sshConfig = sanitizeSshConfig(input?.ssh)
  if (!sshConfig) throw new Error('SSH host is required for remote deploy.')

  const bundle = buildOpenClawDeployBundle({
    template: input?.template,
    target: input?.target,
    token: input?.token,
    scheme: input?.scheme,
    port: input?.port,
    provider: input?.provider,
    useCase: input?.useCase,
    exposure: input?.exposure,
  })
  const materialized = await materializeBundleFiles(bundle)
  const remoteDir = sshConfig.targetDir || '/opt/openclaw'
  const mkdirCommand = buildSshInvocation(sshConfig, `mkdir -p ${shellEscape(remoteDir)}`)
  const scpCommand = buildScpInvocation(sshConfig, materialized.filePaths)
  const bootstrapCommand = buildSshInvocation(
    sshConfig,
    `cd ${shellEscape(remoteDir)} && chmod +x bootstrap.sh && OPENCLAW_APP_DIR=${shellEscape(remoteDir)} bash ./bootstrap.sh`,
  )
  const command = `${mkdirCommand} && ${scpCommand} && ${bootstrapCommand}`
  const result = await startRemoteCommand({
    remoteId: input?.remoteId ?? null,
    name: input?.name ?? bundle.title,
    action: 'ssh-deploy',
    target: sshConfig.host,
    command,
    summary: `Deploying OpenClaw to ${sshConfig.host} over SSH.`,
    makePrimary: input?.makePrimary,
  })
  return {
    ...result,
    token: bundle.token,
    bundle,
  }
}

export const deployOpenClawOverSsh = deployOpenClawBundleOverSsh

export async function runOpenClawRemoteLifecycleAction(input?: {
  remoteId?: string | null
  name?: string | null
  action: 'start' | 'stop' | 'restart' | 'upgrade' | 'backup' | 'restore' | 'rotate-token'
  ssh?: Partial<OpenClawSshConfig> | null
  image?: string | null
  token?: string | null
  backupPath?: string | null
  makePrimary?: boolean
}): Promise<OpenClawRemoteCommandResult> {
  const sshConfig = sanitizeSshConfig(input?.ssh)
  if (!sshConfig) throw new Error('SSH host is required for remote lifecycle actions.')
  const remoteDir = sshConfig.targetDir || '/opt/openclaw'
  const image = normalizeText(input?.image) || 'openclaw:latest'
  const action = input?.action || 'restart'
  let remoteCommand = ''
  let summary = ''
  let rotatedToken: string | undefined
  let backupPath: string | null = null

  if (action === 'start') {
    remoteCommand = `cd ${shellEscape(remoteDir)} && docker compose up -d`
    summary = `Starting OpenClaw on ${sshConfig.host}.`
  } else if (action === 'stop') {
    remoteCommand = `cd ${shellEscape(remoteDir)} && docker compose down`
    summary = `Stopping OpenClaw on ${sshConfig.host}.`
  } else if (action === 'restart') {
    remoteCommand = `cd ${shellEscape(remoteDir)} && docker compose restart`
    summary = `Restarting OpenClaw on ${sshConfig.host}.`
  } else if (action === 'upgrade') {
    remoteCommand = `cd ${shellEscape(remoteDir)} && docker pull ${shellEscape(image)} && docker compose up -d`
    summary = `Pulling ${image} and recreating the OpenClaw stack on ${sshConfig.host}.`
  } else if (action === 'backup') {
    backupPath = path.posix.join(remoteDir, 'backups', `openclaw-backup-${Date.now()}.tgz`)
    remoteCommand = `cd ${shellEscape(remoteDir)} && mkdir -p backups && tar -czf ${shellEscape(backupPath)} .env docker-compose.yml .openclaw workspace && printf '%s\\n' ${shellEscape(backupPath)}`
    summary = `Creating an OpenClaw backup on ${sshConfig.host}.`
  } else if (action === 'restore') {
    backupPath = normalizeText(input?.backupPath) || null
    if (!backupPath) throw new Error('A remote backup path is required for restore.')
    remoteCommand = `cd ${shellEscape(remoteDir)} && tar -xzf ${shellEscape(backupPath)} -C ${shellEscape(remoteDir)} && docker compose up -d`
    summary = `Restoring OpenClaw from ${backupPath} on ${sshConfig.host}.`
  } else {
    rotatedToken = normalizeToken(input?.token) || generateOpenClawGatewayToken()
    remoteCommand = `cd ${shellEscape(remoteDir)} && sed -i.bak -e ${shellEscape(`s/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=${rotatedToken}/`)} .env && docker compose up -d && printf '%s\\n' ${shellEscape(rotatedToken)}`
    summary = `Rotating the OpenClaw gateway token on ${sshConfig.host}.`
  }

  const command = buildSshInvocation(sshConfig, remoteCommand)
  const result = await startRemoteCommand({
    remoteId: input?.remoteId ?? null,
    name: input?.name ?? deriveRemoteDeploymentName(sshConfig.host),
    action,
    target: sshConfig.host,
    command,
    summary,
    backupPath,
    makePrimary: input?.makePrimary,
  })
  return {
    ...result,
    token: rotatedToken,
  }
}

export const runOpenClawRemoteLifecycle = runOpenClawRemoteLifecycleAction
