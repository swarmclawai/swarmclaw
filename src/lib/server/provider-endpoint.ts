import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { getProvider } from '@/lib/providers'
import { loadCredential } from '@/lib/server/credentials/credential-repository'
import { listCredentialIdsByProvider, resolveCredentialSecret } from '@/lib/server/credentials/credential-service'
import { resolveOllamaRuntimeConfig } from '@/lib/server/ollama-runtime'
import { loadProviderConfigs } from '@/lib/server/storage'

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveProviderCredentialId(input: {
  provider?: string | null
  ollamaMode?: string | null
  credentialId?: string | null
}): string | null {
  const normalizedId = clean(input.credentialId)

  // When no credentialId provided, auto-match by provider
  if (!normalizedId) {
    const provider = clean(input.provider)
    if (!provider) return null
    const byProvider = listCredentialIdsByProvider(provider)
      .map((id) => [id, loadCredential(id)] as const)
      .filter(([, cred]) => Boolean(cred))
    if (byProvider.length === 1) return byProvider[0][0]
    if (byProvider.length > 1) {
      // Pick the most recently created credential
      return [...byProvider]
        .sort((a, b) => ((b[1]?.createdAt as number) || 0) - ((a[1]?.createdAt as number) || 0))[0]?.[0] || null
    }
    return null
  }

  if (loadCredential(normalizedId)) return normalizedId

  const provider = clean(input.provider)
  if (!provider) return normalizedId

  const matchingEntries = listCredentialIdsByProvider(provider)
    .map((id) => [id, loadCredential(id)] as const)
    .filter(([, credential]) => Boolean(credential))

  if (provider === 'ollama' && clean(input.ollamaMode) === 'cloud' && matchingEntries.length > 0) {
    return [...matchingEntries]
      .sort((left, right) => {
        const leftCreatedAt = typeof left[1]?.createdAt === 'number' ? left[1].createdAt : 0
        const rightCreatedAt = typeof right[1]?.createdAt === 'number' ? right[1].createdAt : 0
        return rightCreatedAt - leftCreatedAt
      })[0]?.[0] || normalizedId
  }

  const matchingIds = matchingEntries.map(([id]) => id)

  if (matchingIds.length === 1) return matchingIds[0]
  return normalizedId
}

function resolveCredentialApiKey(credentialId?: string | null): string | null {
  const normalized = resolveProviderCredentialId({ credentialId })
  if (!normalized) return null
  return resolveCredentialSecret(normalized)
}

export function resolveProviderApiEndpoint(input: {
  provider?: string | null
  model?: string | null
  ollamaMode?: string | null
  credentialId?: string | null
  apiEndpoint?: string | null
}): string | null {
  const provider = clean(input.provider)
  if (!provider) return null

  const explicitEndpoint = normalizeProviderEndpoint(provider, input.apiEndpoint ?? null)
  if (explicitEndpoint) return explicitEndpoint

  if (provider === 'ollama') {
    const credentialId = resolveProviderCredentialId(input)
    const runtime = resolveOllamaRuntimeConfig({
      model: input.model,
      ollamaMode: input.ollamaMode ?? null,
      apiKey: resolveCredentialApiKey(credentialId),
      apiEndpoint: null,
    })
    return normalizeProviderEndpoint(provider, runtime.endpoint) || runtime.endpoint.replace(/\/+$/, '')
  }

  // Prefer provider config's custom baseUrl over the hardcoded defaultEndpoint
  const pConfigs = loadProviderConfigs()
  const pConfig = pConfigs[provider]
  if (pConfig?.baseUrl) {
    const customNormalized = normalizeProviderEndpoint(provider, pConfig.baseUrl)
    if (customNormalized) return customNormalized
    return pConfig.baseUrl.replace(/\/+$/, '')
  }

  const providerInfo = getProvider(provider)
  if (!providerInfo?.defaultEndpoint) return null
  return normalizeProviderEndpoint(provider, providerInfo.defaultEndpoint) || providerInfo.defaultEndpoint.replace(/\/+$/, '')
}
