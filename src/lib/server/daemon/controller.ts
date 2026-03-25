import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { log } from '@/lib/server/logger'
import {
  DAEMON_LOG_PATH,
  clearDaemonAdminMetadata,
  isProcessRunning,
  readDaemonAdminMetadata,
  writeDaemonAdminMetadata,
} from '@/lib/server/daemon/admin-metadata'
import {
  loadDaemonStatusRecord,
  patchDaemonStatusRecord,
} from '@/lib/server/daemon/daemon-status-repository'
import type {
  DaemonAdminMetadata,
  DaemonConnectorRuntimeState,
  DaemonHealthSummaryPayload,
  DaemonRunningConnectorInfo,
  DaemonStatusPayload,
} from '@/lib/server/daemon/types'
import { DATA_DIR } from '@/lib/server/data-dir'
import { loadEstopState } from '@/lib/server/runtime/estop'
import { getDaemonStatus } from '@/lib/server/runtime/daemon-state/core'
import { daemonAutostartEnvEnabled } from '@/lib/server/runtime/daemon-policy'
import {
  releaseRuntimeLock,
  tryAcquireRuntimeLock,
} from '@/lib/server/runtime/runtime-lock-repository'
import { errorMessage } from '@/lib/shared-utils'

const TAG = 'daemon-controller'
const LAUNCH_LOCK_NAME = 'daemon-launcher'
const LAUNCH_LOCK_TTL_MS = 20_000
const DAEMON_READY_TIMEOUT_MS = 20_000
const DAEMON_POLL_INTERVAL_MS = 250
const DAEMON_STALE_AFTER_MS = 20_000

function now(): number {
  return Date.now()
}

function createLockOwner(): string {
  return `launcher:${process.pid}:${crypto.randomBytes(6).toString('hex')}`
}

function buildDefaultStatus(): DaemonStatusPayload {
  return {
    running: false,
    schedulerActive: false,
    autostartEnabled: daemonAutostartEnvEnabled(),
    backgroundServicesEnabled: true,
    reducedMode: false,
    manualStopRequested: false,
    estop: loadEstopState(),
    queueLength: 0,
    lastProcessed: null,
    nextScheduled: null,
    heartbeat: null,
    health: {
      monitorActive: false,
      connectorMonitorActive: false,
      staleSessions: 0,
      connectorsInBackoff: 0,
      connectorsExhausted: 0,
      checkIntervalSec: 120,
      connectorCheckIntervalSec: 15,
      integrity: {
        enabled: true,
        lastCheckedAt: null,
        lastDriftCount: 0,
      },
    },
    webhookRetry: {
      pendingRetries: 0,
      deadLettered: 0,
    },
    guards: {
      healthCheckRunning: false,
      connectorHealthCheckRunning: false,
      shuttingDown: false,
      providerCircuitBreakers: 0,
    },
  }
}

function buildDefaultHealthSummary(): DaemonHealthSummaryPayload {
  const estop = loadEstopState().level !== 'none'
  return {
    ok: false,
    uptime: 0,
    components: {
      daemon: { status: estop ? 'degraded' : 'stopped' },
      connectors: { healthy: 0, errored: 0, total: 0 },
      providers: { healthy: 0, cooldown: 0, total: 0 },
      gateways: { healthy: 0, degraded: 0, total: 0 },
    },
    estop,
    nextScheduledTask: null,
  }
}

function getDaemonHomeDir(): string {
  const configured = process.env.SWARMCLAW_HOME?.trim()
  if (configured) return path.resolve(configured)
  return path.dirname(DATA_DIR)
}

function resolveDaemonRoot(): string | null {
  const candidates = [
    process.env.SWARMCLAW_BUILD_ROOT,
    process.env.SWARMCLAW_PACKAGE_ROOT,
    process.cwd(),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => path.resolve(value))

  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'src', 'lib', 'server', 'daemon', 'daemon-runtime.ts'))) {
      return root
    }
  }

  return null
}

function resolveDaemonRuntimeEntry(): { root: string; entry: string } {
  const root = resolveDaemonRoot()
  if (!root) {
    throw new Error('Unable to locate daemon runtime entry. Set SWARMCLAW_BUILD_ROOT or SWARMCLAW_PACKAGE_ROOT.')
  }
  return {
    root,
    entry: path.join(root, 'src', 'lib', 'server', 'daemon', 'daemon-runtime.ts'),
  }
}

function buildDaemonUrl(port: number, routePath: string): string {
  const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`
  return `http://127.0.0.1:${port}${normalized}`
}

function withTimeout(timeoutMs = 2_000): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

type DaemonSnapshotResponse = {
  status: DaemonStatusPayload
  healthSummary: DaemonHealthSummaryPayload
}

async function requestDaemon<T>(
  metadata: DaemonAdminMetadata,
  routePath: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers || {})
  headers.set('authorization', `Bearer ${metadata.token}`)
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(buildDaemonUrl(metadata.port, routePath), {
    ...init,
    headers,
    signal: init?.signal || withTimeout(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Daemon admin request failed (${response.status}): ${detail || response.statusText}`)
  }
  return readJsonResponse<T>(response)
}

function daemonRecordLooksLive(): boolean {
  const record = loadDaemonStatusRecord()
  return Boolean(
    record.pid
    && isProcessRunning(record.pid)
    && record.lastHeartbeatAt
    && now() - record.lastHeartbeatAt <= DAEMON_STALE_AFTER_MS,
  )
}

function buildFallbackStatus(): DaemonStatusPayload {
  const record = loadDaemonStatusRecord()
  const base = record.lastStatus ? { ...record.lastStatus } : buildDefaultStatus()
  const running = daemonRecordLooksLive()
  return {
    ...base,
    running,
    schedulerActive: running,
    autostartEnabled: daemonAutostartEnvEnabled(),
    manualStopRequested: record.manualStopRequested,
    estop: loadEstopState(),
  }
}

function buildFallbackHealthSummary(): DaemonHealthSummaryPayload {
  const record = loadDaemonStatusRecord()
  const running = daemonRecordLooksLive()
  const base = record.lastHealthSummary
    ? {
        ...record.lastHealthSummary,
        components: {
          ...record.lastHealthSummary.components,
          daemon: {
            ...record.lastHealthSummary.components.daemon,
          },
        },
      }
    : buildDefaultHealthSummary()

  base.ok = running && base.components.daemon.status !== 'degraded'
  base.components.daemon.status = running
    ? (loadEstopState().level === 'none' ? 'healthy' : 'degraded')
    : 'stopped'
  base.estop = loadEstopState().level !== 'none'
  return base
}

function markDaemonUnavailable(source: string, err?: unknown): void {
  clearDaemonAdminMetadata()
  patchDaemonStatusRecord((current) => {
    const status = current.lastStatus ? { ...current.lastStatus } : buildDefaultStatus()
    status.running = false
    status.schedulerActive = false
    status.estop = loadEstopState()
    return {
      ...current,
      pid: null,
      adminPort: null,
      desiredState: current.manualStopRequested ? 'stopped' : current.desiredState,
      stoppedAt: now(),
      updatedAt: now(),
      lastStopSource: source,
      lastError: err ? errorMessage(err) : current.lastError,
      lastStatus: status,
    }
  })
}

async function getLiveDaemonSnapshot(): Promise<DaemonSnapshotResponse | null> {
  const metadata = readDaemonAdminMetadata()
  if (!metadata) return null
  if (!isProcessRunning(metadata.pid)) {
    markDaemonUnavailable('pid-missing')
    return null
  }
  try {
    return await requestDaemon<DaemonSnapshotResponse>(metadata, '/status')
  } catch (err: unknown) {
    if (!isProcessRunning(metadata.pid)) {
      markDaemonUnavailable('request-failed', err)
      return null
    }
    return null
  }
}

async function waitForDaemonReady(metadata: DaemonAdminMetadata): Promise<void> {
  const deadline = now() + DAEMON_READY_TIMEOUT_MS
  while (now() < deadline) {
    if (!isProcessRunning(metadata.pid)) {
      throw new Error(`Daemon process ${metadata.pid} exited before becoming ready.`)
    }
    try {
      const snapshot = await requestDaemon<DaemonSnapshotResponse>(metadata, '/status')
      patchDaemonStatusRecord((current) => ({
        ...current,
        pid: metadata.pid,
        adminPort: metadata.port,
        desiredState: 'running',
        manualStopRequested: false,
        startedAt: current.startedAt || metadata.launchedAt,
        stoppedAt: null,
        lastHeartbeatAt: now(),
        updatedAt: now(),
        lastError: null,
        lastStatus: snapshot.status,
        lastHealthSummary: snapshot.healthSummary,
      }))
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, DAEMON_POLL_INTERVAL_MS))
    }
  }
  throw new Error(`Timed out waiting for daemon admin server on port ${metadata.port}.`)
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (!isProcessRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve daemon admin port.')))
        return
      }
      const { port } = address
      server.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

function buildDaemonSpawnEnv(root: string, adminPort: number, adminToken: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SWARMCLAW_HOME: getDaemonHomeDir(),
    DATA_DIR,
    WORKSPACE_DIR: process.env.WORKSPACE_DIR,
    BROWSER_PROFILES_DIR: process.env.BROWSER_PROFILES_DIR,
    SWARMCLAW_BUILD_ROOT: process.env.SWARMCLAW_BUILD_ROOT || root,
    SWARMCLAW_PACKAGE_ROOT: process.env.SWARMCLAW_PACKAGE_ROOT || root,
    SWARMCLAW_RUNTIME_ROLE: 'daemon',
    SWARMCLAW_DAEMON_BACKGROUND_SERVICES: '1',
    SWARMCLAW_DAEMON_ADMIN_PORT: String(adminPort),
    SWARMCLAW_DAEMON_ADMIN_TOKEN: adminToken,
  }
}

export async function ensureDaemonProcessRunning(
  source: string,
  opts?: { manualStart?: boolean },
): Promise<boolean> {
  // In dev mode, the daemon may already be running in-process (same Next.js server)
  // without a daemon-admin.json file. Check in-process state first to avoid spawning
  // a subprocess that fails to acquire the already-held lease.
  const inProcessStatus = getDaemonStatus()
  if (inProcessStatus.running) return false

  const manualStart = opts?.manualStart === true
  const record = loadDaemonStatusRecord()
  if (loadEstopState().level !== 'none') return false
  if (!manualStart && !daemonAutostartEnvEnabled()) return false
  if (!manualStart && record.manualStopRequested) return false

  const live = await getLiveDaemonSnapshot()
  if (live?.status.running) return false

  const lockOwner = createLockOwner()
  if (!tryAcquireRuntimeLock(LAUNCH_LOCK_NAME, lockOwner, LAUNCH_LOCK_TTL_MS)) return false

  try {
    const secondCheck = await getLiveDaemonSnapshot()
    if (secondCheck?.status.running) return false

    const { root, entry } = resolveDaemonRuntimeEntry()
    const adminPort = await reservePort()
    const adminToken = crypto.randomBytes(24).toString('hex')
    fs.mkdirSync(path.dirname(DAEMON_LOG_PATH), { recursive: true })
    const logStream = fs.openSync(DAEMON_LOG_PATH, 'a')
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--import', 'tsx', entry, '--port', String(adminPort), '--token', adminToken],
      {
        cwd: root,
        detached: true,
        env: buildDaemonSpawnEnv(root, adminPort, adminToken),
        stdio: ['ignore', logStream, logStream],
      },
    )

    const metadata: DaemonAdminMetadata = {
      pid: child.pid ?? 0,
      port: adminPort,
      token: adminToken,
      launchedAt: now(),
      source,
    }
    if (!metadata.pid) {
      throw new Error('Daemon process failed to spawn.')
    }

    writeDaemonAdminMetadata(metadata)
    patchDaemonStatusRecord((current) => ({
      ...current,
      pid: metadata.pid,
      adminPort: metadata.port,
      desiredState: 'running',
      manualStopRequested: false,
      startedAt: current.startedAt,
      stoppedAt: null,
      updatedAt: now(),
      lastLaunchSource: source,
      lastError: null,
    }))

    await waitForDaemonReady(metadata)
    child.unref()
    return true
  } catch (err: unknown) {
    markDaemonUnavailable(`launch-failed:${source}`, err)
    throw err
  } finally {
    releaseRuntimeLock(LAUNCH_LOCK_NAME, lockOwner)
  }
}

export async function stopDaemonProcess(opts?: {
  source?: string
  manualStop?: boolean
}): Promise<boolean> {
  const source = opts?.source || 'unknown'
  const manualStop = opts?.manualStop === true
  const metadata = readDaemonAdminMetadata()

  if (!metadata || !isProcessRunning(metadata.pid)) {
    clearDaemonAdminMetadata()
    patchDaemonStatusRecord((current) => ({
      ...current,
      pid: null,
      adminPort: null,
      desiredState: 'stopped',
      manualStopRequested: manualStop ? true : current.manualStopRequested,
      stoppedAt: now(),
      updatedAt: now(),
      lastStopSource: source,
      lastStatus: {
        ...(current.lastStatus || buildDefaultStatus()),
        running: false,
        schedulerActive: false,
        manualStopRequested: manualStop ? true : current.manualStopRequested,
        estop: loadEstopState(),
      },
    }))
    return false
  }

  try {
    await requestDaemon<{ ok: boolean }>(metadata, '/stop', {
      method: 'POST',
      body: JSON.stringify({ source }),
    })
  } catch (err: unknown) {
    if (isProcessRunning(metadata.pid)) {
      try {
        process.kill(metadata.pid, 'SIGTERM')
      } catch {
        // Fall through to stale cleanup below.
      }
    }
    log.warn(TAG, `Daemon stop request fell back to SIGTERM (${source})`, errorMessage(err))
  }

  await waitForProcessExit(metadata.pid)
  clearDaemonAdminMetadata()
  patchDaemonStatusRecord((current) => ({
    ...current,
    pid: null,
    adminPort: null,
    desiredState: 'stopped',
    manualStopRequested: manualStop ? true : current.manualStopRequested,
    stoppedAt: now(),
    updatedAt: now(),
    lastStopSource: source,
    lastStatus: {
      ...(current.lastStatus || buildDefaultStatus()),
      running: false,
      schedulerActive: false,
      manualStopRequested: manualStop ? true : current.manualStopRequested,
      estop: loadEstopState(),
    },
  }))
  return true
}

export async function getDaemonStatusSnapshot(): Promise<DaemonStatusPayload> {
  const live = await getLiveDaemonSnapshot()
  if (live) return live.status
  return buildFallbackStatus()
}

export async function getDaemonHealthSummarySnapshot(): Promise<DaemonHealthSummaryPayload> {
  const live = await getLiveDaemonSnapshot()
  if (live) return live.healthSummary
  return buildFallbackHealthSummary()
}

export async function runDaemonHealthCheckViaAdmin(source: string): Promise<DaemonSnapshotResponse> {
  await ensureDaemonProcessRunning(source, { manualStart: true })
  const metadata = readDaemonAdminMetadata()
  if (!metadata) {
    return {
      status: buildFallbackStatus(),
      healthSummary: buildFallbackHealthSummary(),
    }
  }
  try {
    return await requestDaemon<DaemonSnapshotResponse>(metadata, '/health-check', {
      method: 'POST',
      body: JSON.stringify({ source }),
    })
  } catch (err: unknown) {
    markDaemonUnavailable(`health-check:${source}`, err)
    return {
      status: buildFallbackStatus(),
      healthSummary: buildFallbackHealthSummary(),
    }
  }
}

export async function listDaemonConnectorRuntime(): Promise<Record<string, DaemonConnectorRuntimeState>> {
  const metadata = readDaemonAdminMetadata()
  if (!metadata || !isProcessRunning(metadata.pid)) return {}
  try {
    const result = await requestDaemon<{ connectors: Record<string, DaemonConnectorRuntimeState> }>(metadata, '/connectors')
    return result.connectors || {}
  } catch {
    return {}
  }
}

export async function getDaemonConnectorRuntime(connectorId: string): Promise<DaemonConnectorRuntimeState | null> {
  const metadata = readDaemonAdminMetadata()
  if (!metadata || !isProcessRunning(metadata.pid)) return null
  try {
    const result = await requestDaemon<{ connector: DaemonConnectorRuntimeState | null }>(
      metadata,
      `/connectors/${encodeURIComponent(connectorId)}`,
    )
    return result.connector || null
  } catch {
    return null
  }
}

export async function runDaemonConnectorAction(
  connectorId: string,
  action: 'start' | 'stop' | 'repair',
  source: string,
): Promise<DaemonConnectorRuntimeState | null> {
  if (action !== 'stop') {
    await ensureDaemonProcessRunning(source, { manualStart: true })
  }
  const metadata = readDaemonAdminMetadata()
  if (!metadata || !isProcessRunning(metadata.pid)) return null
  const result = await requestDaemon<{ connector: DaemonConnectorRuntimeState | null }>(
    metadata,
    `/connectors/${encodeURIComponent(connectorId)}/actions`,
    {
      method: 'POST',
      body: JSON.stringify({ action, source }),
    },
  )
  return result.connector || null
}

export async function listDaemonRunningConnectors(platform?: string): Promise<DaemonRunningConnectorInfo[]> {
  const metadata = readDaemonAdminMetadata()
  if (!metadata || !isProcessRunning(metadata.pid)) return []
  const query = platform ? `?platform=${encodeURIComponent(platform)}` : ''
  try {
    const result = await requestDaemon<{ connectors: DaemonRunningConnectorInfo[] }>(
      metadata,
      `/connectors/running${query}`,
    )
    return Array.isArray(result.connectors) ? result.connectors : []
  } catch {
    return []
  }
}
