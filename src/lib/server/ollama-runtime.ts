import { isOllamaCloudModel, stripOllamaCloudModelSuffix } from '@/lib/ollama-model'
import { PROVIDER_DEFAULTS } from '@/lib/providers/provider-defaults'

const OLLAMA_CLOUD_KEY_ENV_VARS = ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'] as const

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function isOllamaCloudEndpoint(endpoint: string | null | undefined): boolean {
  const normalized = clean(endpoint)
  if (!normalized) return false
  return /^https?:\/\/(?:www\.|api\.)?ollama\.com(?:\/|$)/i.test(normalized)
}

function hasExplicitEndpoint(endpoint: string | null | undefined): boolean {
  return clean(endpoint) !== null
}

export function resolveOllamaCloudApiKey(explicitApiKey?: string | null): string | null {
  const explicit = clean(explicitApiKey)
  if (explicit && explicit !== 'ollama') return explicit
  for (const envName of OLLAMA_CLOUD_KEY_ENV_VARS) {
    const candidate = clean(process.env[envName])
    if (candidate) return candidate
  }
  return null
}

export function resolveOllamaRuntimeConfig(input: {
  model?: string | null
  apiKey?: string | null
  apiEndpoint?: string | null
}): {
  model: string
  useCloud: boolean
  apiKey: string | null
  endpoint: string
} {
  const rawModel = clean(input.model) || ''
  const explicitApiKey = clean(input.apiKey)
  const explicitEndpoint = clean(input.apiEndpoint)
  const cloudApiKey = resolveOllamaCloudApiKey(explicitApiKey)
  const useCloud = isOllamaCloudEndpoint(explicitEndpoint)
    || (!hasExplicitEndpoint(explicitEndpoint) && (
      Boolean(explicitApiKey && explicitApiKey !== 'ollama')
      || (isOllamaCloudModel(rawModel) && Boolean(cloudApiKey))
    ))

  return {
    model: useCloud ? (stripOllamaCloudModelSuffix(rawModel) || rawModel) : rawModel,
    useCloud,
    apiKey: useCloud ? cloudApiKey : explicitApiKey,
    endpoint: useCloud ? PROVIDER_DEFAULTS.ollamaCloud : (explicitEndpoint || PROVIDER_DEFAULTS.ollama),
  }
}
