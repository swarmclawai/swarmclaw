import { createHash } from 'node:crypto'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sleep } from '@/lib/shared-utils'
import { UPLOAD_DIR } from '@/lib/server/storage'
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
  SANDBOX_UPLOADS_MOUNT,
} from './constants'
import { ensureBrowserBridge, stopBrowserBridgeForScope } from './browser-bridge'
import { execDocker, inspectDockerContainer, readDockerEnvVar, readDockerLabel, readDockerPort } from './docker'
import { createSandboxFsBridge, type SandboxFsBridge } from './fs-bridge'
import { generateNoVncPassword, isNoVncEnabled } from './novnc-auth'
import { maybePruneSandboxes } from './prune'
import {
  readSandboxBrowserRegistry,
  removeSandboxBrowserRegistryEntry,
  upsertSandboxBrowserRegistryEntry,
} from './registry'
import type { AgentSandboxConfig, SandboxSessionContext } from './session-runtime'

export interface NormalizedSandboxBrowserConfig {
  enabled: true
  image: string
  containerPrefix: string
  network: 'none' | 'bridge'
  cdpPort: number
  vncPort: number
  noVncPort: number
  headless: boolean
  enableNoVnc: boolean
  mountUploads: boolean
  autoStartTimeoutMs: number
}

export interface SandboxBrowserContext {
  scopeKey: string
  containerName: string
  cdpEndpoint: string
  cdpPort: number
  bridgeUrl: string
  bridgeAuthToken: string
  noVncPort: number | null
  noVncPassword: string | null
  fsBridge: SandboxFsBridge
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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

function slugifyScopeKey(scopeKey: string): string {
  const slug = scopeKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

export function normalizeSandboxBrowserConfig(config: AgentSandboxConfig | null | undefined): NormalizedSandboxBrowserConfig | null {
  if (!config?.enabled || config.browser?.enabled !== true) return null
  return {
    enabled: true,
    image: trimString(config.browser.image) || DEFAULT_SANDBOX_BROWSER_IMAGE,
    containerPrefix: trimString(config.browser.containerPrefix) || DEFAULT_SANDBOX_BROWSER_PREFIX,
    network: config.browser.network === 'none' ? 'none' : DEFAULT_SANDBOX_BROWSER_NETWORK,
    cdpPort: normalizePositiveInt(config.browser.cdpPort, DEFAULT_SANDBOX_BROWSER_CDP_PORT, 1024, 65_000),
    vncPort: normalizePositiveInt(config.browser.vncPort, DEFAULT_SANDBOX_BROWSER_VNC_PORT, 1024, 65_000),
    noVncPort: normalizePositiveInt(config.browser.noVncPort, DEFAULT_SANDBOX_BROWSER_NOVNC_PORT, 1024, 65_000),
    headless: config.browser.headless ?? DEFAULT_SANDBOX_BROWSER_HEADLESS,
    enableNoVnc: config.browser.enableNoVnc ?? DEFAULT_SANDBOX_BROWSER_ENABLE_NOVNC,
    mountUploads: config.browser.mountUploads ?? DEFAULT_SANDBOX_BROWSER_MOUNT_UPLOADS,
    autoStartTimeoutMs: normalizePositiveInt(
      config.browser.autoStartTimeoutMs,
      DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
      1_000,
      120_000,
    ),
  }
}

function computeSandboxBrowserConfigHash(params: {
  browser: NormalizedSandboxBrowserConfig
  sandbox: SandboxSessionContext
}): string {
  return createHash('sha1')
    .update(JSON.stringify({
      browser: params.browser,
      workspaceDir: params.sandbox.workspaceDir,
      containerWorkdir: params.sandbox.containerWorkdir,
      workspaceAccess: params.sandbox.workspaceAccess,
      scopeKey: params.sandbox.scopeKey,
      uploadsDir: params.browser.mountUploads ? path.resolve(UPLOAD_DIR) : null,
      noVnc: {
        enable: params.browser.enableNoVnc,
        vncPort: params.browser.vncPort,
        noVncPort: params.browser.noVncPort,
      },
    }))
    .digest('hex')
}

async function waitForCdp(cdpEndpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1_000)
      try {
        const res = await fetch(new URL('/json/version', cdpEndpoint), { signal: controller.signal })
        if (res.ok) return true
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // ignore until timeout
    }
    await sleep(150)
  }
  return false
}

async function ensureBrowserImage(image: string): Promise<void> {
  const result = await execDocker(['image', 'inspect', image], true)
  if (result.code === 0) return
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with "docker build -f Dockerfile.sandbox-browser -t ${image} .".`,
  )
}

function buildSandboxBrowserCreateArgs(params: {
  containerName: string
  browser: NormalizedSandboxBrowserConfig
  sandbox: SandboxSessionContext
  configHash: string
  noVncPassword?: string
}): string[] {
  const args = [
    'create',
    '--name', params.containerName,
    '--label', 'swarmclaw.sandboxBrowser=1',
    '--label', `swarmclaw.scopeKey=${params.sandbox.scopeKey}`,
    '--label', `swarmclaw.browserConfigHash=${params.configHash}`,
    '--network', params.browser.network,
    '--security-opt', 'no-new-privileges',
    '-v', `${params.sandbox.workspaceDir}:${params.sandbox.containerWorkdir}:${params.sandbox.workspaceAccess}`,
    '-w', params.sandbox.containerWorkdir,
    '-p', `127.0.0.1::${params.browser.cdpPort}`,
    '-e', `SWARMCLAW_BROWSER_HEADLESS=${params.browser.headless ? '1' : '0'}`,
    '-e', `SWARMCLAW_BROWSER_CDP_PORT=${params.browser.cdpPort}`,
    '-e', `SWARMCLAW_BROWSER_ENABLE_NOVNC=${params.browser.enableNoVnc ? '1' : '0'}`,
    '-e', `SWARMCLAW_BROWSER_VNC_PORT=${params.browser.vncPort}`,
    '-e', `SWARMCLAW_BROWSER_NOVNC_PORT=${params.browser.noVncPort}`,
    // Docker isolation replaces Chromium's process sandbox inside the container.
    '-e', 'SWARMCLAW_BROWSER_NO_SANDBOX=1',
  ]

  if (params.browser.mountUploads) {
    args.push('-v', `${path.resolve(UPLOAD_DIR)}:${SANDBOX_UPLOADS_MOUNT}:ro`)
  }

  if (isNoVncEnabled(params.browser)) {
    args.push('-p', `127.0.0.1::${params.browser.noVncPort}`)
    if (params.noVncPassword) {
      args.push('-e', `SWARMCLAW_BROWSER_NOVNC_PASSWORD=${params.noVncPassword}`)
    }
  }

  args.push(params.browser.image)
  return args
}

export async function ensureSandboxBrowser(params: {
  config: AgentSandboxConfig | null | undefined
  sandbox: SandboxSessionContext | null
}): Promise<SandboxBrowserContext | null> {
  const browser = normalizeSandboxBrowserConfig(params.config)
  if (!browser || !params.sandbox) return null
  await maybePruneSandboxes(params.config)

  const containerName = `${browser.containerPrefix}${slugifyScopeKey(params.sandbox.scopeKey)}`.slice(0, 63)
  const configHash = computeSandboxBrowserConfigHash({ browser, sandbox: params.sandbox })
  const current = await inspectDockerContainer(containerName)
  const currentHash = current.exists
    ? (await readDockerLabel(containerName, 'swarmclaw.browserConfigHash'))
      ?? (await readSandboxBrowserRegistry()).entries.find((entry) => entry.containerName === containerName)?.configHash
      ?? null
    : null

  if (current.exists && currentHash && currentHash !== configHash) {
    await execDocker(['rm', '-f', containerName], true)
  }

  const latest = current.exists && currentHash === configHash
    ? current
    : { exists: false, running: false }

  const shouldEnableNoVnc = isNoVncEnabled(browser)
  const noVncPassword = shouldEnableNoVnc
    ? (latest.exists
        ? await readDockerEnvVar(containerName, 'SWARMCLAW_BROWSER_NOVNC_PASSWORD') || generateNoVncPassword()
        : generateNoVncPassword())
    : null
  if (!latest.exists) {
    await ensureBrowserImage(browser.image)
    await execDocker(buildSandboxBrowserCreateArgs({
      containerName,
      browser,
      sandbox: params.sandbox,
      configHash,
      noVncPassword: noVncPassword || undefined,
    }))
    await execDocker(['start', containerName])
  } else if (!latest.running) {
    await execDocker(['start', containerName])
  }

  const cdpPort = await readDockerPort(containerName, browser.cdpPort)
  if (!cdpPort) {
    throw new Error(`Failed to resolve sandbox browser port mapping for ${containerName}.`)
  }

  const cdpEndpoint = `http://127.0.0.1:${cdpPort}`
  const ready = await waitForCdp(cdpEndpoint, browser.autoStartTimeoutMs)
  if (!ready) {
    throw new Error(`Sandbox browser did not become ready at ${cdpEndpoint} within ${browser.autoStartTimeoutMs}ms.`)
  }

  const mappedNoVncPort = shouldEnableNoVnc
    ? await readDockerPort(containerName, browser.noVncPort)
    : null

  const bridge = await ensureBrowserBridge({
    scopeKey: params.sandbox.scopeKey,
    containerName,
    targetUrl: cdpEndpoint,
    auth: {
      token: crypto.randomBytes(24).toString('hex'),
    },
    noVncPort: mappedNoVncPort ?? null,
    noVncPassword: noVncPassword || null,
  })

  await upsertSandboxBrowserRegistryEntry({
    containerName,
    scopeKey: params.sandbox.scopeKey,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
    image: browser.image,
    configHash,
    cdpPort,
    ...(mappedNoVncPort ? { noVncPort: mappedNoVncPort } : {}),
  })

  return {
    scopeKey: params.sandbox.scopeKey,
    containerName,
    cdpEndpoint: bridge.baseUrl,
    cdpPort,
    bridgeUrl: bridge.baseUrl,
    bridgeAuthToken: bridge.auth.token || '',
    noVncPort: mappedNoVncPort ?? null,
    noVncPassword: noVncPassword || null,
    fsBridge: createSandboxFsBridge({
      workspaceDir: params.sandbox.workspaceDir,
      containerWorkdir: params.sandbox.containerWorkdir,
      workspaceAccess: params.sandbox.workspaceAccess,
      extraMounts: browser.mountUploads
        ? [{
            hostRoot: path.resolve(UPLOAD_DIR),
            containerRoot: SANDBOX_UPLOADS_MOUNT,
            writable: false,
            source: 'uploads',
          }]
        : [],
    }),
  }
}

export async function destroySandboxBrowser(runtime: {
  containerName?: string | null
  scopeKey?: string | null
} | null | undefined): Promise<void> {
  const containerName = trimString(runtime?.containerName)
  if (!containerName) return
  await execDocker(['rm', '-f', containerName], true)
  await removeSandboxBrowserRegistryEntry(containerName)
  const scopeKey = trimString(runtime?.scopeKey)
  if (scopeKey) await stopBrowserBridgeForScope(scopeKey).catch(() => undefined)
}

export function toSandboxBrowserFileUrl(containerPath: string): string {
  return pathToFileURL(containerPath).toString()
}
