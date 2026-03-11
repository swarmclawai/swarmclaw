import type { Agent } from '@/types'
import {
  DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  DEFAULT_SANDBOX_BROWSER_CDP_PORT,
  DEFAULT_SANDBOX_BROWSER_ENABLE_NOVNC,
  DEFAULT_SANDBOX_BROWSER_HEADLESS,
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_BROWSER_MOUNT_UPLOADS,
  DEFAULT_SANDBOX_BROWSER_NETWORK,
  DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
  DEFAULT_SANDBOX_BROWSER_PREFIX,
  DEFAULT_SANDBOX_BROWSER_VNC_PORT,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_PRUNE_IDLE_HOURS,
  DEFAULT_SANDBOX_PRUNE_MAX_AGE_DAYS,
  DEFAULT_SANDBOX_WORKDIR,
} from '@/lib/sandbox-defaults'

export type AgentSandboxConfig = NonNullable<Agent['sandboxConfig']>

export const DEFAULT_AGENT_SANDBOX_CONFIG: AgentSandboxConfig = {
  enabled: true,
  mode: 'all',
  scope: 'session',
  workspaceAccess: 'rw',
  image: DEFAULT_SANDBOX_IMAGE,
  network: 'bridge',
  memoryMb: 512,
  cpus: 1,
  readonlyRoot: false,
  workdir: DEFAULT_SANDBOX_WORKDIR,
  containerPrefix: DEFAULT_SANDBOX_CONTAINER_PREFIX,
  pidsLimit: 256,
  browser: {
    enabled: true,
    image: DEFAULT_SANDBOX_BROWSER_IMAGE,
    containerPrefix: DEFAULT_SANDBOX_BROWSER_PREFIX,
    network: DEFAULT_SANDBOX_BROWSER_NETWORK,
    cdpPort: DEFAULT_SANDBOX_BROWSER_CDP_PORT,
    vncPort: DEFAULT_SANDBOX_BROWSER_VNC_PORT,
    noVncPort: DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
    headless: DEFAULT_SANDBOX_BROWSER_HEADLESS,
    enableNoVnc: DEFAULT_SANDBOX_BROWSER_ENABLE_NOVNC,
    mountUploads: DEFAULT_SANDBOX_BROWSER_MOUNT_UPLOADS,
    autoStartTimeoutMs: DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  },
  prune: {
    idleHours: DEFAULT_SANDBOX_PRUNE_IDLE_HOURS,
    maxAgeDays: DEFAULT_SANDBOX_PRUNE_MAX_AGE_DAYS,
  },
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function normalizeAgentSandboxConfig(config: Agent['sandboxConfig'] | unknown): AgentSandboxConfig {
  const input = asRecord(config)
  const hasBrowser = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'browser'))
  const hasPrune = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'prune'))
  const browserInput = hasBrowser
    ? (input?.browser === null ? null : asRecord(input?.browser))
    : undefined
  const pruneInput = hasPrune
    ? (input?.prune === null ? null : asRecord(input?.prune))
    : undefined

  return {
    ...DEFAULT_AGENT_SANDBOX_CONFIG,
    ...(input ?? {}),
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : DEFAULT_AGENT_SANDBOX_CONFIG.enabled,
    browser: browserInput === undefined
      ? DEFAULT_AGENT_SANDBOX_CONFIG.browser
      : browserInput === null
      ? null
      : {
          ...DEFAULT_AGENT_SANDBOX_CONFIG.browser,
          ...(browserInput ?? {}),
        },
    prune: pruneInput === undefined
      ? DEFAULT_AGENT_SANDBOX_CONFIG.prune
      : pruneInput === null
      ? null
      : {
          ...DEFAULT_AGENT_SANDBOX_CONFIG.prune,
          ...(pruneInput ?? {}),
        },
  }
}
