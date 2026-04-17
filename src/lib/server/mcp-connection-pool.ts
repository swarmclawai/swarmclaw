import type { McpServerConfig } from '@/types'
import { hmrSingleton } from '@/lib/shared-utils'
import { connectMcpServer, disconnectMcpServer } from './mcp-client'

/**
 * Long-lived MCP client pool. Pre-connection took ~100–500 ms per downstream
 * per turn; that's multiplied by (servers × chat turns) for every agent.
 * The pool reuses a single Client/transport per server for the whole process
 * lifetime, re-connecting only when the server's config fingerprint changes
 * or when an explicit evict is requested (e.g. from the `/test` endpoint).
 *
 * State lives on `globalThis` via hmrSingleton so Next.js HMR reloads don't
 * leak child processes (see CLAUDE.md §"hmrSingleton").
 */

interface PoolEntry {
  client: Awaited<ReturnType<typeof connectMcpServer>>['client']
  transport: Awaited<ReturnType<typeof connectMcpServer>>['transport']
  configFingerprint: string
  connectedAt: number
}

type Connector = (config: McpServerConfig) => Promise<{
  client: PoolEntry['client']
  transport: PoolEntry['transport']
}>

type Disconnector = (client: PoolEntry['client'], transport: PoolEntry['transport']) => Promise<void>

interface PoolState {
  entries: Map<string, PoolEntry>
  inflight: Map<string, Promise<PoolEntry>>
  connector: Connector
  disconnector: Disconnector
}

const pool = hmrSingleton<PoolState>('mcpConnectionPool', () => ({
  entries: new Map<string, PoolEntry>(),
  inflight: new Map<string, Promise<PoolEntry>>(),
  connector: connectMcpServer,
  disconnector: disconnectMcpServer,
}))

/**
 * Test-only hook. Swap the connect/disconnect functions with a fake so tests
 * can exercise pool behavior (caching, fingerprinting, coalescing, eviction)
 * without spawning child processes. Pass `undefined` to restore defaults.
 */
export function __setPoolConnector(opts: {
  connect?: Connector
  disconnect?: Disconnector
} = {}): void {
  pool.connector = opts.connect ?? connectMcpServer
  pool.disconnector = opts.disconnect ?? disconnectMcpServer
}

function configFingerprint(c: McpServerConfig): string {
  return JSON.stringify({
    t: c.transport,
    cmd: c.command,
    args: c.args,
    cwd: c.cwd,
    url: c.url,
    env: c.env,
    headers: c.headers,
  })
}

export async function getOrConnectMcpClient(
  config: McpServerConfig,
): Promise<{ client: PoolEntry['client']; transport: PoolEntry['transport'] }> {
  const existing = pool.entries.get(config.id)
  const fp = configFingerprint(config)
  if (existing && existing.configFingerprint === fp) {
    return { client: existing.client, transport: existing.transport }
  }
  // Config changed (or first connect) — drop any stale entry.
  if (existing) {
    await safeDisconnect(existing)
    pool.entries.delete(config.id)
  }
  // Coalesce concurrent connect attempts for the same server id.
  const inflight = pool.inflight.get(config.id)
  if (inflight) {
    const entry = await inflight
    return { client: entry.client, transport: entry.transport }
  }
  const promise = (async () => {
    const { client, transport } = await pool.connector(config)
    const entry: PoolEntry = {
      client,
      transport,
      configFingerprint: fp,
      connectedAt: Date.now(),
    }
    pool.entries.set(config.id, entry)
    return entry
  })()
  pool.inflight.set(config.id, promise)
  try {
    const entry = await promise
    return { client: entry.client, transport: entry.transport }
  } finally {
    pool.inflight.delete(config.id)
  }
}

export async function evictMcpClient(serverId: string): Promise<void> {
  const entry = pool.entries.get(serverId)
  if (!entry) return
  pool.entries.delete(serverId)
  await safeDisconnect(entry)
}

export async function evictAllMcpClients(): Promise<void> {
  const ids = Array.from(pool.entries.keys())
  await Promise.all(ids.map((id) => evictMcpClient(id)))
}

export function poolSize(): number {
  return pool.entries.size
}

export function isPooled(serverId: string): boolean {
  return pool.entries.has(serverId)
}

async function safeDisconnect(entry: PoolEntry): Promise<void> {
  try {
    await pool.disconnector(entry.client, entry.transport)
  } catch {
    /* ignore — we're tearing down anyway */
  }
}
