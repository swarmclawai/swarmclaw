import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { getProvider } from '@/lib/providers'
import { resolveOllamaRuntimeConfig } from '@/lib/server/ollama-runtime'
import { decryptKey, loadCredentials } from '@/lib/server/storage'

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveProviderCredentialId(input: {
  provider?: string | null
  credentialId?: string | null
}): string | null {
  const normalizedId = clean(input.credentialId)
  if (!normalizedId) return null
  const credentials = loadCredentials()
  if (normalizedId && credentials[normalizedId]) return normalizedId

  const provider = clean(input.provider)
  if (!provider) return normalizedId

  const matchingIds = Object.entries(credentials)
    .filter(([, credential]) => credential?.provider === provider)
    .map(([id]) => id)

  if (matchingIds.length === 1) return matchingIds[0]
  return normalizedId
}

function resolveCredentialApiKey(credentialId?: string | null): string | null {
  const normalized = resolveProviderCredentialId({ credentialId })
  if (!normalized) return null
  const credential = loadCredentials()[normalized]
  if (!credential?.encryptedKey) return null
  try {
    return decryptKey(credential.encryptedKey)
  } catch {
    return null
  }
}

export function resolveProviderApiEndpoint(input: {
  provider?: string | null
  model?: string | null
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
      apiKey: resolveCredentialApiKey(credentialId),
      apiEndpoint: null,
    })
    return normalizeProviderEndpoint(provider, runtime.endpoint) || runtime.endpoint.replace(/\/+$/, '')
  }

  const providerInfo = getProvider(provider)
  if (!providerInfo?.defaultEndpoint) return null
  return normalizeProviderEndpoint(provider, providerInfo.defaultEndpoint) || providerInfo.defaultEndpoint.replace(/\/+$/, '')
}
