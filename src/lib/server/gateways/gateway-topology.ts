import { errorMessage } from '@/lib/shared-utils'
import {
  getGatewayProfileById,
  listOpenClawGatewayProfiles,
  updateGatewayProfile,
} from './gateway-profile-service'
import { ensureGatewayConnected } from '@/lib/server/openclaw/gateway'
import type {
  OpenClawEnvironmentSummary,
  GatewayProfile,
  OpenClawDevicePairRequest,
  OpenClawGatewayEnvironmentList,
  OpenClawGatewayEnvironmentStatusSnapshot,
  OpenClawGatewayFleetTopology,
  OpenClawGatewayPresenceEntry,
  OpenClawGatewayRpcError,
  OpenClawGatewaySession,
  OpenClawGatewayTopology,
  OpenClawGatewayTopologyStats,
  OpenClawNode,
  OpenClawNodePairRequest,
  OpenClawPairedDevice,
} from '@/types'

type GatewayRpcClient = {
  connected: boolean
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

interface GatewayTopologyDeps {
  ensureGatewayConnected?: typeof ensureGatewayConnected
  getGatewayProfile?: typeof getGatewayProfileById
  listGatewayProfiles?: typeof listOpenClawGatewayProfiles
  now?: () => number
  persistStats?: typeof updateGatewayProfile
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function extractArray(value: unknown, keys: string[] = []): unknown[] {
  if (Array.isArray(value)) return value
  const record = asObject(value)
  if (!record) return []
  for (const key of keys) {
    const nested = record[key]
    if (Array.isArray(nested)) return nested
  }
  return []
}

function normalizeNode(value: unknown): OpenClawNode | null {
  const record = asObject(value)
  const nodeId = asString(record?.nodeId) || asString(record?.id)
  if (!record || !nodeId) return null
  const stringArray = (key: string): string[] | undefined => {
    const raw = record[key]
    return Array.isArray(raw) ? (raw.map(asString).filter(Boolean) as string[]) : undefined
  }
  return {
    nodeId,
    displayName: asString(record.displayName) || asString(record.name) || undefined,
    platform: asString(record.platform) || undefined,
    version: asString(record.version) || undefined,
    coreVersion: asString(record.coreVersion) || undefined,
    uiVersion: asString(record.uiVersion) || undefined,
    deviceFamily: asString(record.deviceFamily) || undefined,
    modelIdentifier: asString(record.modelIdentifier) || undefined,
    remoteIp: asString(record.remoteIp) || undefined,
    caps: stringArray('caps'),
    commands: stringArray('commands'),
    pathEnv: stringArray('pathEnv'),
    permissions: stringArray('permissions'),
    connectedAtMs: asNumber(record.connectedAtMs) || undefined,
    paired: typeof record.paired === 'boolean' ? record.paired : undefined,
    connected: typeof record.connected === 'boolean' ? record.connected : undefined,
  }
}

function normalizeNodePairing(value: unknown): OpenClawNodePairRequest | null {
  const record = asObject(value)
  const requestId = asString(record?.requestId) || asString(record?.id)
  if (!record || !requestId) return null
  return {
    requestId,
    nodeId: asString(record.nodeId) || undefined,
    displayName: asString(record.displayName) || asString(record.name) || undefined,
    platform: asString(record.platform) || undefined,
    remoteIp: asString(record.remoteIp) || undefined,
    createdAtMs: asNumber(record.createdAtMs) || undefined,
  }
}

function normalizeDevicePairing(value: unknown): OpenClawDevicePairRequest | null {
  const record = asObject(value)
  const requestId = asString(record?.requestId) || asString(record?.id)
  if (!record || !requestId) return null
  return {
    requestId,
    deviceId: asString(record.deviceId) || undefined,
    displayName: asString(record.displayName) || asString(record.name) || undefined,
    role: asString(record.role) || undefined,
    platform: asString(record.platform) || undefined,
    remoteIp: asString(record.remoteIp) || undefined,
    createdAtMs: asNumber(record.createdAtMs) || undefined,
  }
}

function normalizePairedDevice(value: unknown): OpenClawPairedDevice | null {
  const record = asObject(value)
  const deviceId = asString(record?.deviceId) || asString(record?.id)
  if (!record || !deviceId) return null
  return {
    deviceId,
    displayName: asString(record.displayName) || asString(record.name) || undefined,
    role: asString(record.role) || undefined,
    remoteIp: asString(record.remoteIp) || undefined,
    platform: asString(record.platform) || undefined,
    tokens: Array.isArray(record.tokens)
      ? record.tokens.map((token) => {
        const tokenRecord = asObject(token) || {}
        return {
          role: asString(tokenRecord.role) || undefined,
          scopes: Array.isArray(tokenRecord.scopes)
            ? tokenRecord.scopes.map(asString).filter(Boolean) as string[]
            : undefined,
          createdAtMs: asNumber(tokenRecord.createdAtMs) || undefined,
          rotatedAtMs: asNumber(tokenRecord.rotatedAtMs) || undefined,
          revokedAtMs: asNumber(tokenRecord.revokedAtMs) || undefined,
        }
      })
      : undefined,
  }
}

function normalizeSession(value: unknown): OpenClawGatewaySession | null {
  const record = asObject(value)
  const id = asString(record?.id)
    || asString(record?.sessionId)
    || asString(record?.sessionKey)
    || asString(record?.key)
  if (!record || !id) return null
  return {
    id,
    key: asString(record.key) || asString(record.sessionKey),
    title: asString(record.title) || asString(record.name),
    channel: asString(record.channel) || asString(record.platform) || asString(record.provider),
    sender: asString(record.sender) || asString(record.senderId) || asString(record.from),
    updatedAt: asNumber(record.updatedAt) || asNumber(record.lastMessageAt) || asNumber(record.createdAt),
    status: asString(record.status) || asString(record.state),
  }
}

function normalizePresence(value: unknown): OpenClawGatewayPresenceEntry | null {
  const record = asObject(value)
  const id = asString(record?.id)
    || asString(record?.key)
    || asString(record?.deviceId)
    || asString(record?.instanceId)
  if (!record || !id) return null
  return {
    id,
    label: asString(record.label) || asString(record.name) || asString(record.text),
    mode: asString(record.mode),
    deviceId: asString(record.deviceId),
    host: asString(record.host) || asString(record.hostname),
    status: asString(record.status) || asString(record.state),
    updatedAt: asNumber(record.updatedAt) || asNumber(record.seenAt) || asNumber(record.createdAt),
  }
}

function uniqueStrings(...items: Array<readonly string[] | undefined>): string[] {
  const values = new Set<string>()
  for (const item of items) {
    for (const value of item || []) {
      const trimmed = asString(value)
      if (trimmed) values.add(trimmed)
    }
  }
  return [...values].sort((left, right) => left.localeCompare(right))
}

function normalizeEnvironmentStatus(value: unknown): OpenClawEnvironmentSummary['status'] {
  return value === 'available'
    || value === 'starting'
    || value === 'stopping'
    || value === 'error'
    ? value
    : 'unavailable'
}

function normalizeEnvironment(value: unknown): OpenClawEnvironmentSummary | null {
  const record = asObject(value)
  const id = asString(record?.id) || asString(record?.environmentId)
  if (!record || !id) return null
  const capabilities = Array.isArray(record.capabilities)
    ? uniqueStrings(record.capabilities.map(asString).filter(Boolean) as string[])
    : undefined
  return {
    id,
    type: asString(record.type) || 'local',
    label: asString(record.label) || asString(record.name),
    status: normalizeEnvironmentStatus(record.status),
    capabilities: capabilities && capabilities.length > 0 ? capabilities : undefined,
  }
}

function deriveEnvironments(profile: GatewayProfile, nodes: OpenClawNode[], connected: boolean): OpenClawEnvironmentSummary[] {
  const gatewayEnvironment: OpenClawEnvironmentSummary = {
    id: 'gateway',
    type: 'local',
    label: profile.name || 'Gateway local',
    status: connected ? 'available' : 'unavailable',
    capabilities: ['agent.run', 'sessions', 'tools', 'workspace'],
  }
  const nodeEnvironments = nodes.map((node) => {
    const capabilities = uniqueStrings(node.caps, node.commands)
    return {
      id: `node:${node.nodeId}`,
      type: 'node',
      label: node.displayName || node.nodeId,
      status: node.connected === true ? 'available' : 'unavailable',
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    } satisfies OpenClawEnvironmentSummary
  })
  return [gatewayEnvironment, ...nodeEnvironments]
}

async function safeRpc<T>(
  gateway: GatewayRpcClient,
  method: string,
  errors: OpenClawGatewayRpcError[],
  normalize: (value: unknown) => T,
  params: Record<string, unknown> = {},
): Promise<T> {
  try {
    return normalize(await gateway.rpc(method, params))
  } catch (err: unknown) {
    errors.push({ method, message: errorMessage(err) })
    return normalize(null)
  }
}

function topologyStats(params: {
  nodes: OpenClawNode[]
  nodePairings: OpenClawNodePairRequest[]
  devicePairings: OpenClawDevicePairRequest[]
  pairedDevices: OpenClawPairedDevice[]
  sessions: OpenClawGatewaySession[]
  presence: OpenClawGatewayPresenceEntry[]
  environments: OpenClawEnvironmentSummary[]
  errors: OpenClawGatewayRpcError[]
  refreshedAt: number
}): OpenClawGatewayTopologyStats {
  return {
    nodeCount: params.nodes.length,
    connectedNodeCount: params.nodes.filter((node) => node.connected === true).length,
    pendingNodePairings: params.nodePairings.length,
    pairedDeviceCount: params.pairedDevices.length,
    pendingDevicePairings: params.devicePairings.length,
    sessionCount: params.sessions.length,
    presenceCount: params.presence.length,
    environmentCount: params.environments.length,
    availableEnvironmentCount: params.environments.filter((environment) => environment.status === 'available').length,
    pendingPairingCount: params.nodePairings.length + params.devicePairings.length,
    hasErrors: params.errors.length > 0,
    lastTopologyCheckedAt: params.refreshedAt,
    lastTopologyErrorCount: params.errors.length,
    lastTopologyError: params.errors[0]?.message || null,
  }
}

export async function buildOpenClawGatewayTopology(
  profile: GatewayProfile,
  deps: GatewayTopologyDeps = {},
): Promise<OpenClawGatewayTopology> {
  const now = deps.now ?? (() => Date.now())
  const refreshedAt = now()
  const ensureConnected = deps.ensureGatewayConnected ?? ensureGatewayConnected
  const errors: OpenClawGatewayRpcError[] = []
  const gateway = await ensureConnected({ profileId: profile.id }) as GatewayRpcClient | null

  if (!gateway) {
    errors.push({ method: 'gateway.connect', message: 'OpenClaw gateway not connected' })
    const stats = topologyStats({
      nodes: [],
      nodePairings: [],
      devicePairings: [],
      pairedDevices: [],
      sessions: [],
      presence: [],
      environments: [],
      errors,
      refreshedAt,
    })
    return {
      profile,
      connected: false,
      refreshedAt,
      stats,
      nodes: [],
      nodePairings: [],
      devicePairings: [],
      pairedDevices: [],
      sessions: [],
      presence: [],
      environments: [],
      errors,
    }
  }

  const [nodes, nodePairingsRaw, devicePairingsRaw, sessions, presence, rpcEnvironments] = await Promise.all([
    safeRpc(gateway, 'node.list', errors, (value) =>
      extractArray(value, ['nodes']).map(normalizeNode).filter(Boolean) as OpenClawNode[],
    ),
    safeRpc(gateway, 'node.pair.list', errors, (value) => extractArray(asObject(value)?.pending ?? value, ['pending'])),
    safeRpc(gateway, 'device.pair.list', errors, (value) => asObject(value) || {}),
    safeRpc(gateway, 'sessions.list', errors, (value) =>
      extractArray(value, ['sessions', 'items', 'data']).map(normalizeSession).filter(Boolean) as OpenClawGatewaySession[],
    ),
    safeRpc(gateway, 'system-presence', errors, (value) =>
      extractArray(value, ['presence']).map(normalizePresence).filter(Boolean) as OpenClawGatewayPresenceEntry[],
    ),
    safeRpc(gateway, 'environments.list', errors, (value) =>
      extractArray(value, ['environments']).map(normalizeEnvironment).filter(Boolean) as OpenClawEnvironmentSummary[],
    ),
  ])

  const devicePairingsRecord = asObject(devicePairingsRaw) || {}
  const nodePairings = extractArray(nodePairingsRaw, ['pending'])
    .map(normalizeNodePairing)
    .filter(Boolean) as OpenClawNodePairRequest[]
  const devicePairings = extractArray(devicePairingsRecord.pending)
    .map(normalizeDevicePairing)
    .filter(Boolean) as OpenClawDevicePairRequest[]
  const pairedDevices = extractArray(devicePairingsRecord.paired)
    .map(normalizePairedDevice)
    .filter(Boolean) as OpenClawPairedDevice[]
  const environments = rpcEnvironments.length > 0
    ? rpcEnvironments
    : deriveEnvironments(profile, nodes, gateway.connected)
  const stats = topologyStats({
    nodes,
    nodePairings,
    devicePairings,
    pairedDevices,
    sessions,
    presence,
    environments,
    errors,
    refreshedAt,
  })

  const persisted = (deps.persistStats ?? updateGatewayProfile)(profile.id, { stats })

  return {
    profile: persisted || profile,
    connected: gateway.connected,
    refreshedAt,
    stats,
    nodes,
    nodePairings,
    devicePairings,
    pairedDevices,
    sessions,
    presence,
    environments,
    errors,
  }
}

export async function listOpenClawGatewayEnvironments(
  id: string,
  deps: GatewayTopologyDeps = {},
): Promise<OpenClawGatewayEnvironmentList | null> {
  const topology = await getOpenClawGatewayTopology(id, deps)
  if (!topology) return null
  return {
    profile: topology.profile,
    connected: topology.connected,
    refreshedAt: topology.refreshedAt,
    environments: topology.environments,
    errors: topology.errors,
  }
}

export async function getOpenClawGatewayEnvironmentStatus(
  id: string,
  environmentId: string,
  deps: GatewayTopologyDeps = {},
): Promise<OpenClawGatewayEnvironmentStatusSnapshot | null> {
  const profile = (deps.getGatewayProfile ?? getGatewayProfileById)(id)
  if (!profile) return null
  const now = deps.now ?? (() => Date.now())
  const refreshedAt = now()
  const ensureConnected = deps.ensureGatewayConnected ?? ensureGatewayConnected
  const errors: OpenClawGatewayRpcError[] = []
  const gateway = await ensureConnected({ profileId: profile.id }) as GatewayRpcClient | null
  if (!gateway) {
    errors.push({ method: 'gateway.connect', message: 'OpenClaw gateway not connected' })
    return { profile, connected: false, refreshedAt, environment: null, errors }
  }
  const environment = await safeRpc(
    gateway,
    'environments.status',
    errors,
    (value) => normalizeEnvironment(value),
    { environmentId },
  )
  return {
    profile,
    connected: gateway.connected,
    refreshedAt,
    environment,
    errors,
  }
}

function emptyTotals(generatedAt: number): OpenClawGatewayFleetTopology['totals'] {
  return {
    gatewayCount: 0,
    connectedGatewayCount: 0,
    nodeCount: 0,
    connectedNodeCount: 0,
    environmentCount: 0,
    availableEnvironmentCount: 0,
    pendingNodePairings: 0,
    pairedDeviceCount: 0,
    pendingDevicePairings: 0,
    sessionCount: 0,
    presenceCount: 0,
    pendingPairingCount: 0,
    hasErrors: false,
    lastTopologyCheckedAt: generatedAt,
    lastTopologyErrorCount: 0,
    lastTopologyError: null,
  }
}

export async function getOpenClawGatewayTopology(
  id: string,
  deps: GatewayTopologyDeps = {},
): Promise<OpenClawGatewayTopology | null> {
  const profile = (deps.getGatewayProfile ?? getGatewayProfileById)(id)
  if (!profile) return null
  return buildOpenClawGatewayTopology(profile, deps)
}

export async function getOpenClawGatewayFleetTopology(
  deps: GatewayTopologyDeps = {},
): Promise<OpenClawGatewayFleetTopology> {
  const now = deps.now ?? (() => Date.now())
  const generatedAt = now()
  const listProfiles = deps.listGatewayProfiles ?? listOpenClawGatewayProfiles
  const gateways = await Promise.all(
    listProfiles().map((profile) => buildOpenClawGatewayTopology(profile, {
      ...deps,
      now: () => generatedAt,
    })),
  )
  const totals = gateways.reduce((acc, topology) => {
    acc.gatewayCount += 1
    if (topology.connected) acc.connectedGatewayCount += 1
    acc.nodeCount = (acc.nodeCount || 0) + (topology.stats.nodeCount || 0)
    acc.connectedNodeCount = (acc.connectedNodeCount || 0) + (topology.stats.connectedNodeCount || 0)
    acc.pendingNodePairings = (acc.pendingNodePairings || 0) + (topology.stats.pendingNodePairings || 0)
    acc.pairedDeviceCount = (acc.pairedDeviceCount || 0) + (topology.stats.pairedDeviceCount || 0)
    acc.pendingDevicePairings = (acc.pendingDevicePairings || 0) + (topology.stats.pendingDevicePairings || 0)
    acc.sessionCount = (acc.sessionCount || 0) + (topology.stats.sessionCount || 0)
    acc.presenceCount = (acc.presenceCount || 0) + (topology.stats.presenceCount || 0)
    acc.environmentCount = (acc.environmentCount || 0) + (topology.stats.environmentCount || 0)
    acc.availableEnvironmentCount = (acc.availableEnvironmentCount || 0) + (topology.stats.availableEnvironmentCount || 0)
    acc.pendingPairingCount += topology.stats.pendingPairingCount
    acc.hasErrors = acc.hasErrors || topology.stats.hasErrors
    acc.lastTopologyErrorCount = (acc.lastTopologyErrorCount || 0) + (topology.stats.lastTopologyErrorCount || 0)
    acc.lastTopologyError = acc.lastTopologyError || topology.stats.lastTopologyError || null
    return acc
  }, emptyTotals(generatedAt))

  return { generatedAt, gateways, totals }
}
