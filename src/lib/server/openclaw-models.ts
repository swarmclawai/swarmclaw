import { ensureGatewayConnected } from './openclaw-gateway'

interface ModelPolicy {
  defaultModel?: string
  allowedModels?: string[]
  fetchedAt: number
}

let cachedPolicy: ModelPolicy | null = null
const CACHE_TTL = 60_000 // 60 seconds

export async function fetchGatewayModelPolicy(): Promise<ModelPolicy | null> {
  if (cachedPolicy && Date.now() - cachedPolicy.fetchedAt < CACHE_TTL) {
    return cachedPolicy
  }

  const gw = await ensureGatewayConnected()
  if (!gw) return cachedPolicy ?? null

  try {
    const result = await gw.rpc('config.get') as Record<string, unknown> | undefined
    if (!result) return null

    const agentDefaults = (result.agents as Record<string, unknown>)?.defaults as Record<string, unknown> | undefined
    const defaultModel = typeof agentDefaults?.model === 'string' ? agentDefaults.model : undefined
    const rawModels = agentDefaults?.models

    let allowedModels: string[] | undefined
    if (Array.isArray(rawModels)) {
      allowedModels = rawModels.filter((m): m is string => typeof m === 'string')
    }

    cachedPolicy = {
      defaultModel,
      allowedModels,
      fetchedAt: Date.now(),
    }
    return cachedPolicy
  } catch {
    return cachedPolicy ?? null
  }
}

export function buildAllowedModelKeys(policy: ModelPolicy | null): string[] | null {
  if (!policy) return null
  const models = new Set<string>()
  if (policy.defaultModel) models.add(policy.defaultModel)
  if (policy.allowedModels) {
    for (const m of policy.allowedModels) models.add(m)
  }
  return models.size > 0 ? Array.from(models) : null
}

export function invalidateModelPolicyCache() {
  cachedPolicy = null
}
