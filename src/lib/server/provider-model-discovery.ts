import crypto from 'crypto'
import { hmrSingleton } from '@/lib/shared-utils'
import { getProviderList } from '@/lib/providers'
import { OPENAI_COMPATIBLE_DEFAULTS } from '@/lib/server/provider-health'
import { decryptKey, loadCredentials } from '@/lib/server/storage'
import type { ProviderInfo, ProviderModelDiscoveryResult } from '@/types'

type DiscoveryStrategy = 'openai-compatible' | 'anthropic' | 'google' | 'ollama' | 'openclaw'

export interface DiscoveryDescriptor {
  providerId: string
  providerName: string
  strategy: DiscoveryStrategy
  endpoint?: string
  requiresApiKey: boolean
  optionalApiKey: boolean
  supportsDiscovery: boolean
}

interface DiscoverProviderModelsInput {
  providerId: string
  credentialId?: string | null
  endpoint?: string | null
  force?: boolean
  requiresApiKey?: boolean
}

interface DiscoveryCacheEntry {
  expiresAt: number
  value: ProviderModelDiscoveryResult
}

const CLOUD_CACHE_TTL_MS = 15 * 60_000
const LOCAL_CACHE_TTL_MS = 60_000
const ERROR_CACHE_TTL_MS = 30_000
const DISCOVERY_TIMEOUT_MS = 10_000
const discoveryState = hmrSingleton('__swarmclaw_provider_model_discovery__', () => ({
  cache: new Map<string, DiscoveryCacheEntry>(),
  pending: new Map<string, Promise<ProviderModelDiscoveryResult>>(),
}))

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeEndpoint(raw: string | null | undefined, fallback = ''): string {
  return (clean(raw) || fallback).replace(/\/+$/, '')
}

function supportsBuiltInModelDiscovery(providerId: string): boolean {
  return !['claude-cli', 'codex-cli', 'opencode-cli'].includes(providerId)
}

function normalizeGoogleModelsEndpoint(raw: string | null | undefined): string {
  const fallback = 'https://generativelanguage.googleapis.com/v1beta'
  const normalized = normalizeEndpoint(raw, fallback)
    .replace(/\/openai$/i, '')
    .replace(/\/models$/i, '')
  return `${normalized}/models`
}

function resolveProviderInfo(providerId: string): ProviderInfo | null {
  return getProviderList().find((provider) => provider.id === providerId) || null
}

export function resolveDescriptor(input: DiscoverProviderModelsInput): DiscoveryDescriptor | null {
  const providerId = clean(input.providerId)
  const provider = resolveProviderInfo(providerId)
  const requiresApiKeyOverride = typeof input.requiresApiKey === 'boolean' ? input.requiresApiKey : undefined

  if (providerId === 'custom') {
    const endpoint = normalizeEndpoint(input.endpoint)
    if (!endpoint) return null
    return {
      providerId,
      providerName: 'Custom Provider',
      strategy: 'openai-compatible',
      endpoint,
      requiresApiKey: requiresApiKeyOverride ?? true,
      optionalApiKey: false,
      supportsDiscovery: true,
    }
  }

  if (providerId === 'openclaw') {
    return {
      providerId,
      providerName: 'OpenClaw',
      strategy: 'openclaw',
      endpoint: normalizeEndpoint(input.endpoint, 'http://localhost:18789'),
      requiresApiKey: requiresApiKeyOverride ?? false,
      optionalApiKey: true,
      supportsDiscovery: true,
    }
  }

  if (!provider) return null
  const supportsDiscovery = provider.supportsModelDiscovery ?? supportsBuiltInModelDiscovery(providerId)
  if (!supportsDiscovery) {
    return {
      providerId,
      providerName: provider.name,
      strategy: 'openai-compatible',
      endpoint: undefined,
      requiresApiKey: provider.requiresApiKey,
      optionalApiKey: Boolean(provider.optionalApiKey),
      supportsDiscovery: false,
    }
  }

  if (providerId === 'anthropic') {
    return {
      providerId,
      providerName: provider.name,
      strategy: 'anthropic',
      requiresApiKey: requiresApiKeyOverride ?? provider.requiresApiKey,
      optionalApiKey: Boolean(provider.optionalApiKey),
      supportsDiscovery,
    }
  }

  if (providerId === 'google') {
    return {
      providerId,
      providerName: provider.name,
      strategy: 'google',
      endpoint: normalizeGoogleModelsEndpoint(input.endpoint || provider.defaultEndpoint || ''),
      requiresApiKey: requiresApiKeyOverride ?? provider.requiresApiKey,
      optionalApiKey: Boolean(provider.optionalApiKey),
      supportsDiscovery,
    }
  }

  if (providerId === 'ollama') {
    const ollamaEndpoint = normalizeEndpoint(input.endpoint, provider.defaultEndpoint || 'http://localhost:11434')
    const isCloud = /^https?:\/\/(?:www\.)?ollama\.com(?:\/|$)/i.test(ollamaEndpoint)
    return {
      providerId,
      providerName: provider.name,
      strategy: isCloud ? 'openai-compatible' : 'ollama',
      endpoint: ollamaEndpoint,
      requiresApiKey: requiresApiKeyOverride ?? (isCloud ? true : provider.requiresApiKey),
      optionalApiKey: isCloud ? false : Boolean(provider.optionalApiKey),
      supportsDiscovery,
    }
  }

  const openAiDefault = OPENAI_COMPATIBLE_DEFAULTS[providerId as keyof typeof OPENAI_COMPATIBLE_DEFAULTS]?.defaultEndpoint
  const endpoint = normalizeEndpoint(input.endpoint, provider.defaultEndpoint || openAiDefault || '')
  return {
    providerId,
    providerName: provider.name,
    strategy: 'openai-compatible',
    endpoint,
    requiresApiKey: requiresApiKeyOverride ?? provider.requiresApiKey,
    optionalApiKey: Boolean(provider.optionalApiKey),
    supportsDiscovery,
  }
}

export function parseErrorMessage(text: string, fallback: string): string {
  const body = text.trim()
  if (!body) return fallback
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) return parsed.error.message.trim()
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch {
    // Ignore invalid JSON and fall back to the raw text.
  }
  return body.slice(0, 300) || fallback
}

function resolveCredentialApiKey(credentialId: string | null | undefined): string | null {
  const id = clean(credentialId)
  if (!id) return null
  try {
    const credentials = loadCredentials()
    const credential = credentials[id]
    if (!credential?.encryptedKey) return null
    return decryptKey(credential.encryptedKey)
  } catch {
    return null
  }
}

function hashApiKey(apiKey: string | null): string {
  if (!apiKey) return 'anon'
  return crypto.createHash('sha1').update(apiKey).digest('hex').slice(0, 12)
}

export function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const model of models) {
    const trimmed = model.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function normalizeModelId(modelId: string, strategy: DiscoveryStrategy): string {
  const trimmed = modelId.trim()
  if (!trimmed) return ''
  if (strategy === 'ollama') return trimmed.replace(/:latest$/i, '')
  if (strategy === 'google' && trimmed.startsWith('models/')) return trimmed.slice('models/'.length)
  return trimmed
}

export function looksLikeChatModel(providerId: string, modelId: string): boolean {
  const normalized = modelId.toLowerCase()
  if (!normalized) return false

  const universalExclusions = [
    'embedding',
    'rerank',
    'moderation',
    'whisper',
    'transcribe',
    'transcription',
    'tts',
    'speech',
    'text-to-speech',
    'stable-diffusion',
    'sdxl',
    'flux',
    'playground-v2',
    'pix2pix',
    'clip',
  ]
  if (universalExclusions.some((token) => normalized.includes(token))) return false

  if (providerId === 'openai') return /^(gpt-|o1($|-)|o3($|-)|o4($|-)|chatgpt-)/.test(normalized)
  if (providerId === 'anthropic') return normalized.startsWith('claude-')
  if (providerId === 'google') return normalized.startsWith('gemini-')
  if (providerId === 'deepseek') return normalized.startsWith('deepseek-')
  if (providerId === 'xai') return normalized.startsWith('grok-')

  return true
}

export function extractCandidateModelIds(payload: unknown, strategy: DiscoveryStrategy): string[] {
  const source = payload as {
    data?: unknown[]
    models?: unknown[]
  }
  const candidates: string[] = []
  const append = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim())
  }

  const readCollection = (items: unknown[] | undefined) => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (typeof item === 'string') {
        append(item)
        continue
      }
      if (!item || typeof item !== 'object') continue
      const record = item as { id?: unknown; name?: unknown; model?: unknown; baseModelId?: unknown }
      append(record.id)
      append(record.name)
      append(record.model)
      append(record.baseModelId)
    }
  }

  if (Array.isArray(payload)) readCollection(payload)
  readCollection(source.data)
  readCollection(source.models)

  const normalized = candidates
    .map((candidate) => normalizeModelId(candidate, strategy))
    .filter(Boolean)
  return dedupeModels(normalized)
}

export function extractDiscoveredModels(
  providerId: string,
  strategy: DiscoveryStrategy,
  payload: unknown,
): { models: string[]; rawCount: number } {
  const candidates = extractCandidateModelIds(payload, strategy)
  const filtered = strategy === 'ollama'
    ? candidates
    : candidates.filter((candidate) => looksLikeChatModel(providerId, candidate))
  return {
    models: dedupeModels(filtered),
    rawCount: candidates.length,
  }
}

export function ttlForDescriptor(descriptor: DiscoveryDescriptor, ok: boolean): number {
  if (!ok) return ERROR_CACHE_TTL_MS
  if (descriptor.strategy === 'ollama' || descriptor.strategy === 'openclaw') return LOCAL_CACHE_TTL_MS
  return CLOUD_CACHE_TTL_MS
}

function buildCacheKey(
  descriptor: DiscoveryDescriptor,
  credentialId: string | null | undefined,
  apiKey: string | null,
): string {
  return [
    descriptor.providerId,
    descriptor.strategy,
    descriptor.endpoint || '',
    clean(credentialId),
    hashApiKey(apiKey),
  ].join('::')
}

async function fetchModelsFromProvider(
  descriptor: DiscoveryDescriptor,
  apiKey: string | null,
): Promise<{ ok: boolean; models: string[]; message: string }> {
  const headers: Record<string, string> = {}
  let url = descriptor.endpoint || ''

  if (descriptor.strategy === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models'
    if (apiKey) headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (descriptor.strategy === 'google') {
    url = descriptor.endpoint || normalizeGoogleModelsEndpoint('')
    if (apiKey) {
      const searchParams = new URLSearchParams({ key: apiKey })
      url = `${url}?${searchParams.toString()}`
    }
  } else if (descriptor.strategy === 'ollama') {
    url = `${descriptor.endpoint}/api/tags`
  } else {
    url = `${descriptor.endpoint}/models`
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      models: [],
      message: parseErrorMessage(text, `${descriptor.providerName} returned ${res.status}.`),
    }
  }

  const payload = await res.json().catch(() => ({}))
  const { models, rawCount } = extractDiscoveredModels(descriptor.providerId, descriptor.strategy, payload)
  if (models.length === 0) {
    return {
      ok: true,
      models: [],
      message: rawCount > 0
        ? `${descriptor.providerName} returned ${rawCount} model(s), but none looked chat-capable.`
        : `${descriptor.providerName} did not report any models.`,
    }
  }

  const message = rawCount > models.length
    ? `${descriptor.providerName} returned ${rawCount} model(s); showing ${models.length} likely chat models.`
    : `${descriptor.providerName} returned ${models.length} live model(s).`
  return { ok: true, models, message }
}

function buildResult(
  descriptor: DiscoveryDescriptor,
  data: Partial<ProviderModelDiscoveryResult> & Pick<ProviderModelDiscoveryResult, 'ok' | 'models'>,
): ProviderModelDiscoveryResult {
  return {
    ok: data.ok,
    providerId: descriptor.providerId,
    providerName: descriptor.providerName,
    models: data.models,
    cached: Boolean(data.cached),
    fetchedAt: data.fetchedAt ?? Date.now(),
    cacheTtlMs: data.cacheTtlMs ?? ttlForDescriptor(descriptor, data.ok),
    supportsDiscovery: descriptor.supportsDiscovery,
    missingCredential: data.missingCredential,
    message: data.message,
  }
}

export async function discoverProviderModels(
  input: DiscoverProviderModelsInput,
): Promise<ProviderModelDiscoveryResult> {
  const descriptor = resolveDescriptor(input)
  if (!descriptor) {
    return {
      ok: false,
      providerId: clean(input.providerId) || 'unknown',
      providerName: undefined,
      models: [],
      cached: false,
      fetchedAt: Date.now(),
      cacheTtlMs: ERROR_CACHE_TTL_MS,
      supportsDiscovery: false,
      message: 'Live model discovery is not available for this provider configuration.',
    }
  }

  if (!descriptor.supportsDiscovery) {
    return buildResult(descriptor, {
      ok: false,
      models: [],
      message: 'This provider does not expose a live model catalog here. You can still type a model name manually.',
    })
  }

  const apiKey = resolveCredentialApiKey(input.credentialId)
  if (descriptor.requiresApiKey && !apiKey) {
    return buildResult(descriptor, {
      ok: false,
      models: [],
      missingCredential: true,
      message: 'Add an API key to fetch the live model list. Manual model entry still works.',
    })
  }

  const cacheKey = buildCacheKey(descriptor, input.credentialId, apiKey)
  const now = Date.now()
  if (!input.force) {
    const cached = discoveryState.cache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return { ...cached.value, cached: true }
    }
    const pending = discoveryState.pending.get(cacheKey)
    if (pending) return pending
  }

  const promise = (async () => {
    const fetchedAt = Date.now()
    try {
      const result = await fetchModelsFromProvider(descriptor, apiKey)
      const built = buildResult(descriptor, {
        ok: result.ok,
        models: result.models,
        message: result.message,
        fetchedAt,
      })
      discoveryState.cache.set(cacheKey, {
        expiresAt: fetchedAt + ttlForDescriptor(descriptor, result.ok),
        value: built,
      })
      return built
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch live models.'
      const built = buildResult(descriptor, {
        ok: false,
        models: [],
        message,
        fetchedAt,
      })
      discoveryState.cache.set(cacheKey, {
        expiresAt: fetchedAt + ERROR_CACHE_TTL_MS,
        value: built,
      })
      return built
    } finally {
      discoveryState.pending.delete(cacheKey)
    }
  })()

  discoveryState.pending.set(cacheKey, promise)
  return promise
}
