import type {
  Agent,
  AgentRoutingStrategy,
  AgentRoutingTarget,
  GatewayProfile,
  ProviderType,
} from '@/types'
import { deriveOpenClawWsUrl, normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { loadGatewayProfiles } from './storage'
import { isProviderCoolingDown } from './provider-health'

const DEFAULT_OPENCLAW_ENDPOINT = 'http://localhost:18789/v1'
const DEFAULT_OPENCLAW_MODEL = 'default'

export interface ResolvedAgentRoute {
  id: string
  label: string
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  role?: NonNullable<AgentRoutingTarget['role']>
  priority: number
  source: 'agent' | 'routing-target'
}

interface RouteSeed {
  id: string
  label?: string
  provider?: ProviderType | null
  model?: string | null
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  role?: AgentRoutingTarget['role']
  priority?: number
  source: ResolvedAgentRoute['source']
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

function normalizeGateway(raw: unknown, id: string): GatewayProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const gateway = raw as Partial<GatewayProfile> & Record<string, unknown>
  const endpoint = normalizeProviderEndpoint(
    'openclaw',
    typeof gateway.endpoint === 'string' && gateway.endpoint.trim()
      ? gateway.endpoint
      : DEFAULT_OPENCLAW_ENDPOINT,
  )
  if (!endpoint) return null
  return {
    id,
    name: typeof gateway.name === 'string' && gateway.name.trim() ? gateway.name.trim() : id,
    provider: 'openclaw',
    endpoint,
    wsUrl: typeof gateway.wsUrl === 'string' && gateway.wsUrl.trim() ? gateway.wsUrl.trim() : deriveOpenClawWsUrl(endpoint),
    credentialId: typeof gateway.credentialId === 'string' && gateway.credentialId.trim() ? gateway.credentialId.trim() : null,
    status: gateway.status === 'healthy' || gateway.status === 'degraded' || gateway.status === 'offline' || gateway.status === 'pending' ? gateway.status : 'unknown',
    notes: typeof gateway.notes === 'string' ? gateway.notes : null,
    tags: ensureStringArray(gateway.tags),
    lastError: typeof gateway.lastError === 'string' ? gateway.lastError : null,
    lastCheckedAt: typeof gateway.lastCheckedAt === 'number' ? gateway.lastCheckedAt : null,
    lastModelCount: typeof gateway.lastModelCount === 'number' ? gateway.lastModelCount : null,
    discoveredHost: typeof gateway.discoveredHost === 'string' ? gateway.discoveredHost : null,
    discoveredPort: typeof gateway.discoveredPort === 'number' ? gateway.discoveredPort : null,
    isDefault: gateway.isDefault === true,
    createdAt: typeof gateway.createdAt === 'number' ? gateway.createdAt : Date.now(),
    updatedAt: typeof gateway.updatedAt === 'number' ? gateway.updatedAt : Date.now(),
  }
}

function findGatewayProfile(
  gatewayProfiles: GatewayProfile[],
  profileId?: string | null,
): GatewayProfile | null {
  const id = typeof profileId === 'string' ? profileId.trim() : ''
  if (!id) return null
  return gatewayProfiles.find((profile) => profile.id === id) || null
}

export function getGatewayProfiles(provider: GatewayProfile['provider'] | null = null): GatewayProfile[] {
  const all = loadGatewayProfiles()
  return Object.entries(all)
    .map(([id, value]) => normalizeGateway(value, id))
    .filter((value): value is GatewayProfile => Boolean(value))
    .filter((value) => !provider || value.provider === provider)
    .sort((a, b) => {
      if ((a.isDefault === true) !== (b.isDefault === true)) return a.isDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export function getGatewayProfile(profileId?: string | null): GatewayProfile | null {
  return findGatewayProfile(getGatewayProfiles(), profileId)
}

function defaultGatewayProfile(gatewayProfiles: GatewayProfile[]): GatewayProfile | null {
  return gatewayProfiles.find((profile) => profile.isDefault) || gatewayProfiles[0] || null
}

function roleWeight(strategy: AgentRoutingStrategy, role?: AgentRoutingTarget['role']): number {
  const normalized = role || 'primary'
  const matrix: Record<AgentRoutingStrategy, Record<string, number>> = {
    single: { primary: 0, backup: 10, premium: 20, reasoning: 30, economy: 40 },
    balanced: { primary: 0, premium: 4, economy: 4, reasoning: 6, backup: 12 },
    economy: { economy: 0, primary: 10, backup: 18, premium: 28, reasoning: 36 },
    premium: { premium: 0, reasoning: 4, primary: 10, backup: 18, economy: 28 },
    reasoning: { reasoning: 0, premium: 4, primary: 10, backup: 18, economy: 28 },
  }
  return matrix[strategy][normalized] ?? 50
}

function dedupeCredentialIds(primary: string | null | undefined, candidates: string[] | undefined): string[] {
  const seen = new Set<string>()
  const normalizedPrimary = typeof primary === 'string' && primary.trim() ? primary.trim() : null
  const result: string[] = []
  for (const value of ensureStringArray(candidates)) {
    if (normalizedPrimary && value === normalizedPrimary) continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function buildRouteFromSeed(
  seed: RouteSeed,
  gatewayProfiles: GatewayProfile[],
  agentGatewayProfileId?: string | null,
): ResolvedAgentRoute | null {
  const provider = (seed.provider || 'claude-cli') as ProviderType
  let gatewayProfileId = seed.gatewayProfileId ?? null
  if (!gatewayProfileId && provider === 'openclaw') {
    gatewayProfileId = agentGatewayProfileId ?? defaultGatewayProfile(gatewayProfiles)?.id ?? null
  }
  const gatewayProfile = findGatewayProfile(gatewayProfiles, gatewayProfileId)

  const providerFromGateway = gatewayProfile?.provider === 'openclaw' ? 'openclaw' : provider
  const apiEndpoint = normalizeProviderEndpoint(
    providerFromGateway,
    seed.apiEndpoint ?? gatewayProfile?.endpoint ?? null,
  )
  const model = (seed.model || '').trim() || (providerFromGateway === 'openclaw' ? DEFAULT_OPENCLAW_MODEL : '')
  if (!providerFromGateway || !model) return null

  const credentialId = seed.credentialId ?? gatewayProfile?.credentialId ?? null
  return {
    id: seed.id,
    label: seed.label?.trim() || (gatewayProfile?.name || `${providerFromGateway}:${model}`),
    provider: providerFromGateway,
    model,
    credentialId,
    fallbackCredentialIds: dedupeCredentialIds(credentialId, seed.fallbackCredentialIds),
    apiEndpoint,
    gatewayProfileId,
    role: seed.role,
    priority: typeof seed.priority === 'number' ? seed.priority : 100,
    source: seed.source,
  }
}

function dedupeRoutes(routes: ResolvedAgentRoute[]): ResolvedAgentRoute[] {
  const seen = new Set<string>()
  const deduped: ResolvedAgentRoute[] = []
  for (const route of routes) {
    const key = [
      route.provider,
      route.model,
      route.credentialId || '',
      route.apiEndpoint || '',
      route.gatewayProfileId || '',
    ].join('::')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(route)
  }
  return deduped
}

export function resolveAgentRouteCandidates(
  agent: Agent | null | undefined,
  preferredStrategy?: AgentRoutingStrategy | null,
): ResolvedAgentRoute[] {
  return resolveAgentRouteCandidatesWithProfiles(agent, getGatewayProfiles('openclaw'), preferredStrategy)
}

export function resolveAgentRouteCandidatesWithProfiles(
  agent: Agent | null | undefined,
  gatewayProfiles: GatewayProfile[],
  preferredStrategy?: AgentRoutingStrategy | null,
  isCoolingDown: (providerId: string) => boolean = isProviderCoolingDown,
): ResolvedAgentRoute[] {
  if (!agent) return []
  const strategy = preferredStrategy || agent.routingStrategy || 'single'
  const seeds: RouteSeed[] = [
    {
      id: 'base',
      label: agent.name,
      provider: agent.provider,
      model: agent.model,
      credentialId: agent.credentialId ?? null,
      fallbackCredentialIds: agent.fallbackCredentialIds || [],
      apiEndpoint: agent.apiEndpoint ?? null,
      gatewayProfileId: agent.gatewayProfileId ?? null,
      role: 'primary',
      priority: 0,
      source: 'agent',
    },
    ...((agent.routingTargets || []).map((target, index) => ({
      id: target.id || `route-${index + 1}`,
      label: target.label,
      provider: target.provider,
      model: target.model,
      credentialId: target.credentialId ?? null,
      fallbackCredentialIds: target.fallbackCredentialIds || [],
      apiEndpoint: target.apiEndpoint ?? null,
      gatewayProfileId: target.gatewayProfileId ?? null,
      role: target.role,
      priority: typeof target.priority === 'number' ? target.priority : index + 1,
      source: 'routing-target' as const,
    }))),
  ]

  return dedupeRoutes(
    seeds
      .map((seed) => buildRouteFromSeed(seed, gatewayProfiles, agent.gatewayProfileId ?? null))
      .filter((route): route is ResolvedAgentRoute => Boolean(route)),
  ).sort((left, right) => {
    const leftCooling = isCoolingDown(left.provider)
    const rightCooling = isCoolingDown(right.provider)
    if (leftCooling !== rightCooling) return leftCooling ? 1 : -1
    const leftRole = roleWeight(strategy, left.role)
    const rightRole = roleWeight(strategy, right.role)
    if (leftRole !== rightRole) return leftRole - rightRole
    if (left.priority !== right.priority) return left.priority - right.priority
    return left.label.localeCompare(right.label)
  })
}

export function resolvePrimaryAgentRoute(
  agent: Agent | null | undefined,
  preferredStrategy?: AgentRoutingStrategy | null,
): ResolvedAgentRoute | null {
  return resolveAgentRouteCandidates(agent, preferredStrategy)[0] || null
}

export function applyResolvedRoute<T extends {
  provider: ProviderType
  model: string
  credentialId?: string | null
  fallbackCredentialIds?: string[]
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
}>(
  target: T,
  route: ResolvedAgentRoute | null | undefined,
): T {
  if (!route) return target
  return {
    ...target,
    provider: route.provider,
    model: route.model,
    credentialId: route.credentialId ?? null,
    fallbackCredentialIds: [...route.fallbackCredentialIds],
    apiEndpoint: route.apiEndpoint ?? null,
    gatewayProfileId: route.gatewayProfileId ?? null,
  }
}
