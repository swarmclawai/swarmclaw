import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  getManagedProcess,
  killManagedProcess,
  removeManagedProcess,
  startManagedProcess,
} from './process-manager'
import { normalizeOpenClawEndpoint, deriveOpenClawWsUrl } from '@/lib/openclaw-endpoint'

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

export interface OpenClawLocalDeployStatus {
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

export interface OpenClawDeployBundleFile {
  name: string
  language: 'bash' | 'yaml' | 'env' | 'toml' | 'text'
  content: string
}

export interface OpenClawDeployBundle {
  template: OpenClawRemoteDeployTemplate
  provider: OpenClawRemoteDeployProvider
  providerLabel: string
  title: string
  summary: string
  endpoint: string
  wsUrl: string
  token: string
  runbook: string[]
  files: OpenClawDeployBundleFile[]
}

interface LocalRuntimeState {
  processId: string | null
  port: number
  endpoint: string
  wsUrl: string
  token: string | null
  startedAt: number | null
  lastError: string | null
}

interface DeployRuntimeState {
  local: LocalRuntimeState
}

interface RemoteProviderMeta {
  id: OpenClawRemoteDeployProvider
  label: string
  shortLabel: string
  bootstrapHint: string
  summary: string
}

const DEFAULT_LOCAL_PORT = 18789
const DEFAULT_REMOTE_PORT = 18789
const GLOBAL_KEY = '__swarmclaw_openclaw_deploy__' as const

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

function getRuntimeState(): DeployRuntimeState {
  const fallback: DeployRuntimeState = {
    local: {
      processId: null,
      port: DEFAULT_LOCAL_PORT,
      endpoint: normalizeOpenClawEndpoint(`http://127.0.0.1:${DEFAULT_LOCAL_PORT}`),
      wsUrl: deriveOpenClawWsUrl(`http://127.0.0.1:${DEFAULT_LOCAL_PORT}`),
      token: null,
      startedAt: null,
      lastError: null,
    },
  }
  const globalState = globalThis as typeof globalThis & { [GLOBAL_KEY]?: DeployRuntimeState }
  if (!globalState[GLOBAL_KEY]) {
    globalState[GLOBAL_KEY] = fallback
  }
  return globalState[GLOBAL_KEY] || fallback
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

function buildLocalRunCommand(port: number, token?: string | null): string {
  const parts = [
    'npx',
    'openclaw',
    'gateway',
    'run',
    '--allow-unconfigured',
    '--force',
    '--bind',
    'loopback',
    '--port',
    String(port),
  ]
  if (token) {
    parts.push('--auth', 'token', '--token', token)
  }
  return parts.join(' ')
}

function buildLocalInstallCommand(port: number, token?: string | null): string {
  const parts = [
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForLocalRuntime(processId: string, attempts = 12): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const process = getManagedProcess(processId)
    if (!process || process.status !== 'running') break
    if ((process.log || '').toLowerCase().includes('listening')) return
    await wait(500)
  }
}

function readTail(text: string, size = 1200): string {
  if (!text) return ''
  return text.length <= size ? text : text.slice(text.length - size)
}

function currentLocalStatus(): OpenClawLocalDeployStatus {
  const state = getRuntimeState()
  const processId = state.local.processId
  const process = processId ? getManagedProcess(processId) : null
  const running = !!process && process.status === 'running'

  if (!running && processId && process && process.status !== 'running') {
    state.local.lastError = readTail(process.log || '') || state.local.lastError
    state.local.processId = null
    state.local.startedAt = null
  }

  const endpoint = normalizeOpenClawEndpoint(`http://127.0.0.1:${state.local.port}`)
  return {
    running,
    processId: running ? processId : null,
    pid: running ? (process?.pid ?? null) : null,
    port: state.local.port,
    endpoint,
    wsUrl: deriveOpenClawWsUrl(endpoint),
    token: state.local.token || null,
    startedAt: running ? state.local.startedAt : null,
    tail: process ? readTail(process.log || '') : '',
    lastError: running ? null : (state.local.lastError || null),
    launchCommand: buildLocalRunCommand(state.local.port, state.local.token),
    installCommand: buildLocalInstallCommand(state.local.port, state.local.token),
  }
}

export function getOpenClawLocalDeployStatus(): OpenClawLocalDeployStatus {
  return currentLocalStatus()
}

export function generateOpenClawGatewayToken(): string {
  return randomBytes(24).toString('base64url')
}

export async function startOpenClawLocalDeploy(input?: {
  port?: number
  token?: string | null
}): Promise<{ local: OpenClawLocalDeployStatus; token: string }> {
  const state = getRuntimeState()
  const current = currentLocalStatus()
  if (current.running && current.processId) {
    killManagedProcess(current.processId)
    removeManagedProcess(current.processId)
  }

  const port = sanitizePort(input?.port, DEFAULT_LOCAL_PORT)
  const token = normalizeToken(input?.token) || generateOpenClawGatewayToken()
  const endpoint = normalizeOpenClawEndpoint(`http://127.0.0.1:${port}`)
  const wsUrl = deriveOpenClawWsUrl(endpoint)
  const binary = resolveBundledOpenClawBinary()
  const args = [
    binary,
    'gateway',
    'run',
    '--allow-unconfigured',
    '--force',
    '--bind',
    'loopback',
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
    background: true,
    timeoutMs: 24 * 60 * 60_000,
  })

  if (result.status !== 'running') {
    const message = result.output || result.tail || 'OpenClaw failed to start.'
    state.local = {
      processId: null,
      port,
      endpoint,
      wsUrl,
      token,
      startedAt: null,
      lastError: message,
    }
    throw new Error(message)
  }

  state.local = {
    processId: result.processId,
    port,
    endpoint,
    wsUrl,
    token,
    startedAt: Date.now(),
    lastError: null,
  }

  await waitForLocalRuntime(result.processId)

  return {
    local: currentLocalStatus(),
    token,
  }
}

export function stopOpenClawLocalDeploy(): OpenClawLocalDeployStatus {
  const state = getRuntimeState()
  const processId = state.local.processId
  if (processId) {
    const process = getManagedProcess(processId)
    if (process?.status === 'running') {
      killManagedProcess(processId)
    }
    removeManagedProcess(processId)
  }
  state.local.processId = null
  state.local.startedAt = null
  return currentLocalStatus()
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

function buildDockerComposeFile(): string {
  return `services:
  openclaw-gateway:
    image: \${OPENCLAW_IMAGE:-openclaw:latest}
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      OPENCLAW_GATEWAY_BIND: \${OPENCLAW_GATEWAY_BIND:-lan}
    volumes:
      - \${OPENCLAW_CONFIG_DIR:-./.openclaw}:/home/node/.openclaw
      - \${OPENCLAW_WORKSPACE_DIR:-./workspace}:/home/node/.openclaw/workspace
    ports:
      - "\${OPENCLAW_GATEWAY_PORT:-18789}:18789"
      - "\${OPENCLAW_BRIDGE_PORT:-18790}:18790"
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

function buildDockerEnvFile(token: string): string {
  return `OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=${token}
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_CONFIG_DIR=./.openclaw
OPENCLAW_WORKSPACE_DIR=./workspace
`
}

function buildDockerBootstrapScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

APP_DIR="\${OPENCLAW_APP_DIR:-$HOME/openclaw}"

mkdir -p "$APP_DIR"
cd "$APP_DIR"
mkdir -p .openclaw workspace

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. On Ubuntu 24.04 you can install it with:"
  echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin"
  exit 1
fi

docker pull "\${OPENCLAW_IMAGE:-openclaw:latest}"
docker compose up -d
docker compose ps
`
}

function buildCloudInitFile(token: string): string {
  const envFile = buildDockerEnvFile(token)
  const composeFile = buildDockerComposeFile()
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
runcmd:
  - mkdir -p /opt/openclaw/.openclaw /opt/openclaw/workspace
  - systemctl enable --now docker
  - bash -lc 'cd /opt/openclaw && docker pull "\${OPENCLAW_IMAGE:-openclaw:latest}"'
  - bash -lc 'cd /opt/openclaw && docker compose up -d'
final_message: "OpenClaw gateway bootstrap complete. Run: sudo docker compose -f /opt/openclaw/docker-compose.yml ps"
`
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
): string[] {
  const endpointHost = deriveRemoteDeploymentName(endpoint)
  return [
    `Provision a small Ubuntu 24.04 server on ${providerMeta.label}. ${providerMeta.bootstrapHint}`,
    'Let first boot finish, then confirm the service with: sudo docker compose -f /opt/openclaw/docker-compose.yml ps',
    `Point a DNS name, reverse proxy, or Tailscale hostname at ${endpointHost} and keep the generated token private.`,
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

  if (template === 'render') {
    return {
      template,
      provider: 'generic',
      providerLabel: 'Render',
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
    title: `${providerMeta.shortLabel} OpenClaw Smart Deploy`,
    summary: `${providerMeta.summary} This bundle only uses the official OpenClaw Docker image and gives you both manual Docker files and a cloud-init quickstart.`,
    endpoint,
    wsUrl,
    token,
    runbook: buildDockerRunbook(providerMeta, endpoint),
    files: [
      { name: 'cloud-init.yaml', language: 'yaml', content: buildCloudInitFile(token) },
      { name: '.env', language: 'env', content: buildDockerEnvFile(token) },
      { name: 'docker-compose.yml', language: 'yaml', content: buildDockerComposeFile() },
      { name: 'bootstrap.sh', language: 'bash', content: buildDockerBootstrapScript() },
    ],
  }
}
