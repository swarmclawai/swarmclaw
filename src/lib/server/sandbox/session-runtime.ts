import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Agent, Session } from '@/types'
import { isMainSession } from '@/lib/server/agents/main-agent-loop'
import {
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_WORKDIR,
} from './constants'
import { detectDocker } from './docker-detect'
import { execDocker, inspectDockerContainer, readDockerLabel } from './docker'
import { maybePruneSandboxes } from './prune'
import { upsertSandboxRegistryEntry } from './registry'

export type AgentSandboxConfig = NonNullable<Agent['sandboxConfig']>
export type SandboxMode = 'off' | 'non-main' | 'all'
export type SandboxScope = 'session' | 'agent'
export type SandboxWorkspaceAccess = 'ro' | 'rw'

export interface NormalizedSandboxConfig {
  enabled: true
  mode: SandboxMode
  scope: SandboxScope
  workspaceAccess: SandboxWorkspaceAccess
  image: string
  network: 'none' | 'bridge'
  memoryMb: number
  cpus: number
  readonlyRoot: boolean
  workdir: string
  containerPrefix: string
  pidsLimit: number
  setupCommand?: string
}

export interface SandboxRuntimeStatus {
  sandboxed: boolean
  mode: SandboxMode
  scope: SandboxScope
  scopeKey: string | null
  config: NormalizedSandboxConfig | null
}

export interface SandboxSessionContext {
  containerName: string
  containerWorkdir: string
  workspaceDir: string
  workspaceAccess: SandboxWorkspaceAccess
  mode: SandboxMode
  scope: SandboxScope
  scopeKey: string
  config: NormalizedSandboxConfig
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeContainerWorkdir(value: unknown): string {
  const trimmed = trimString(value)
  if (!trimmed) return DEFAULT_SANDBOX_WORKDIR
  const absolute = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const normalized = path.posix.normalize(absolute)
  return normalized === '.' ? DEFAULT_SANDBOX_WORKDIR : normalized
}

function slugifyScopeKey(scopeKey: string): string {
  const slug = scopeKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizePositiveFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function normalizeSandboxConfig(config: AgentSandboxConfig | null | undefined): NormalizedSandboxConfig | null {
  if (!config?.enabled) return null
  const mode = config.mode === 'off' || config.mode === 'non-main' || config.mode === 'all'
    ? config.mode
    : 'all'
  const scope = config.scope === 'agent' ? 'agent' : 'session'
  const containerPrefix = trimString(config.containerPrefix) || DEFAULT_SANDBOX_CONTAINER_PREFIX

  return {
    enabled: true,
    mode,
    scope,
    workspaceAccess: config.workspaceAccess === 'ro' ? 'ro' : 'rw',
    image: trimString(config.image) || DEFAULT_SANDBOX_IMAGE,
    network: config.network === 'bridge' ? 'bridge' : 'none',
    memoryMb: normalizePositiveInt(config.memoryMb, 512, 64, 65_536),
    cpus: normalizePositiveFloat(config.cpus, 1, 0.1, 64),
    readonlyRoot: config.readonlyRoot === true,
    workdir: normalizeContainerWorkdir(config.workdir),
    containerPrefix,
    pidsLimit: normalizePositiveInt(config.pidsLimit, 256, 16, 32_768),
    ...(trimString(config.setupCommand) ? { setupCommand: trimString(config.setupCommand) } : {}),
  }
}

export function resolveSandboxRuntimeStatus(params: {
  config: AgentSandboxConfig | null | undefined
  session?: Session | null
  agentId?: string | null
  sessionId?: string | null
}): SandboxRuntimeStatus {
  const config = normalizeSandboxConfig(params.config)
  if (!config) {
    return {
      sandboxed: false,
      mode: 'off',
      scope: 'session',
      scopeKey: null,
      config: null,
    }
  }

  const agentId = trimString(params.agentId) || trimString(params.session?.agentId)
  const sessionId = trimString(params.sessionId) || trimString(params.session?.id)
  const scopeKey = config.scope === 'agent'
    ? (agentId ? `agent:${agentId}` : sessionId ? `session:${sessionId}` : null)
    : (sessionId ? `session:${sessionId}` : agentId ? `agent:${agentId}` : null)

  let sandboxed = false
  if (scopeKey) {
    if (config.mode === 'all') {
      sandboxed = true
    } else if (config.mode === 'non-main' && params.session) {
      sandboxed = !isMainSession(params.session)
    }
  }

  return {
    sandboxed,
    mode: config.mode,
    scope: config.scope,
    scopeKey,
    config,
  }
}

function computeSandboxConfigHash(params: {
  config: NormalizedSandboxConfig
  workspaceDir: string
  scopeKey: string
}): string {
  return createHash('sha1')
    .update(JSON.stringify({
      config: params.config,
      workspaceDir: params.workspaceDir,
      scopeKey: params.scopeKey,
    }))
    .digest('hex')
}

function buildSandboxCreateArgs(params: {
  containerName: string
  scopeKey: string
  configHash: string
  config: NormalizedSandboxConfig
  workspaceDir: string
}): string[] {
  const args = [
    'create',
    '--name', params.containerName,
    '--label', 'swarmclaw.sandbox=1',
    '--label', `swarmclaw.scopeKey=${params.scopeKey}`,
    '--label', `swarmclaw.configHash=${params.configHash}`,
    '--network', params.config.network,
    '--memory', `${params.config.memoryMb}m`,
    '--cpus', String(params.config.cpus),
    '--pids-limit', String(params.config.pidsLimit),
    '--security-opt', 'no-new-privileges',
    '-v', `${params.workspaceDir}:${params.config.workdir}:${params.config.workspaceAccess}`,
    '-w', params.config.workdir,
  ]

  if (params.config.readonlyRoot) {
    args.push(
      '--read-only',
      '--tmpfs', '/tmp:rw,size=128m',
      '--tmpfs', '/var/tmp:rw,size=128m',
      '--tmpfs', '/run:rw,size=32m',
    )
  }

  args.push(params.config.image, 'sleep', 'infinity')
  return args
}

export function resolveSandboxWorkdir(params: {
  workspaceDir: string
  hostWorkdir: string
  containerWorkdir: string
}): { hostWorkdir: string; containerWorkdir: string } {
  const relative = path.relative(params.workspaceDir, params.hostWorkdir)
  if (!relative || relative === '') {
    return {
      hostWorkdir: params.workspaceDir,
      containerWorkdir: params.containerWorkdir,
    }
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      hostWorkdir: params.workspaceDir,
      containerWorkdir: params.containerWorkdir,
    }
  }

  return {
    hostWorkdir: params.hostWorkdir,
    containerWorkdir: path.posix.join(
      params.containerWorkdir,
      ...relative.split(path.sep).filter(Boolean),
    ),
  }
}

export async function ensureSessionSandbox(params: {
  config: AgentSandboxConfig | null | undefined
  session?: Session | null
  agentId?: string | null
  sessionId?: string | null
  workspaceDir: string
}): Promise<SandboxSessionContext | null> {
  const status = resolveSandboxRuntimeStatus(params)
  if (!status.sandboxed || !status.config || !status.scopeKey) return null
  await maybePruneSandboxes(params.config)

  const docker = detectDocker()
  if (!docker.available) {
    throw new Error('Sandbox is enabled but Docker is not available. Install Docker Desktop or disable the sandbox in agent settings.')
  }

  const containerName = `${status.config.containerPrefix}${slugifyScopeKey(status.scopeKey)}`.slice(0, 63)
  const configHash = computeSandboxConfigHash({
    config: status.config,
    workspaceDir: params.workspaceDir,
    scopeKey: status.scopeKey,
  })

  const current = await inspectDockerContainer(containerName)
  const currentHash = current.exists ? await readDockerLabel(containerName, 'swarmclaw.configHash') : null
  if (current.exists && currentHash && currentHash !== configHash) {
    await execDocker(['rm', '-f', containerName], true)
  }

  const next = current.exists && currentHash === configHash
    ? current
    : { exists: false, running: false }

  if (!next.exists) {
    await execDocker(buildSandboxCreateArgs({
      containerName,
      scopeKey: status.scopeKey,
      configHash,
      config: status.config,
      workspaceDir: params.workspaceDir,
    }))
    await execDocker(['start', containerName])
    if (status.config.setupCommand) {
      await execDocker(['exec', '-i', containerName, '/bin/sh', '-lc', status.config.setupCommand])
    }
  } else if (!next.running) {
    await execDocker(['start', containerName])
  }

  await upsertSandboxRegistryEntry({
    containerName,
    scopeKey: status.scopeKey,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
    image: status.config.image,
    configHash,
  })

  return {
    containerName,
    containerWorkdir: status.config.workdir,
    workspaceDir: params.workspaceDir,
    workspaceAccess: status.config.workspaceAccess,
    mode: status.mode,
    scope: status.scope,
    scopeKey: status.scopeKey,
    config: status.config,
  }
}
