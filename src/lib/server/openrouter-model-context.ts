import fs from 'node:fs/promises'
import path from 'node:path'

import { fetchWithTimeout } from '@/lib/fetch-timeout'
import { DATA_DIR } from '@/lib/server/data-dir'

interface OpenRouterModelEntry {
  id?: string
  context_length?: number
  top_provider?: {
    context_length?: number
  }
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelEntry[]
}

interface OpenRouterModelContextCache {
  loadedAt: number
  models: Record<string, number>
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2_000
const CACHE_PATH = path.join(DATA_DIR, 'openrouter-model-context.json')

let cache: OpenRouterModelContextCache | null = null
let loading: Promise<void> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseModelEntry(value: unknown): OpenRouterModelEntry | null {
  if (!isRecord(value)) return null

  const entry: OpenRouterModelEntry = {}
  if (typeof value.id === 'string') entry.id = value.id
  if (typeof value.context_length === 'number') entry.context_length = value.context_length

  if (isRecord(value.top_provider)) {
    const topProvider: OpenRouterModelEntry['top_provider'] = {}
    if (typeof value.top_provider.context_length === 'number') {
      topProvider.context_length = value.top_provider.context_length
    }
    entry.top_provider = topProvider
  }

  return entry
}

function parseModelsResponse(value: unknown): OpenRouterModelsResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) return {}
  return {
    data: value.data
      .map(parseModelEntry)
      .filter((entry): entry is OpenRouterModelEntry => entry !== null),
  }
}

function parseCache(value: unknown): OpenRouterModelContextCache | null {
  if (!isRecord(value) || typeof value.loadedAt !== 'number' || !isRecord(value.models)) {
    return null
  }

  const models: Record<string, number> = {}
  for (const [id, contextLength] of Object.entries(value.models)) {
    if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0) {
      models[id] = contextLength
    }
  }

  return { loadedAt: value.loadedAt, models }
}

function isFreshCache(value: OpenRouterModelContextCache | null): value is OpenRouterModelContextCache {
  return value !== null
    && Number.isFinite(value.loadedAt)
    && Date.now() - value.loadedAt <= CACHE_TTL_MS
}

async function readCache(): Promise<OpenRouterModelContextCache | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8')
    const parsed = parseCache(JSON.parse(raw))
    return isFreshCache(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeCache(nextCache: OpenRouterModelContextCache): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    await fs.writeFile(CACHE_PATH, JSON.stringify(nextCache), 'utf8')
  } catch {
    // Best-effort cache. Runtime behavior should not depend on disk writes.
  }
}

function buildModelContextMap(response: OpenRouterModelsResponse): Record<string, number> {
  const models: Record<string, number> = {}
  for (const entry of response.data || []) {
    if (!entry.id) continue
    const contextLength = entry.top_provider?.context_length || entry.context_length
    if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0) {
      models[entry.id] = contextLength
    }
  }
  return models
}

async function fetchOpenRouterModels(): Promise<OpenRouterModelContextCache | null> {
  try {
    const response = await fetchWithTimeout(OPENROUTER_MODELS_URL, {}, FETCH_TIMEOUT_MS)
    if (!response.ok) return null

    const payload = parseModelsResponse(await response.json())
    return {
      loadedAt: Date.now(),
      models: buildModelContextMap(payload),
    }
  } catch {
    return null
  }
}

async function loadOpenRouterModelContextCache(): Promise<void> {
  const diskCache = await readCache()
  if (diskCache) {
    cache = diskCache
    return
  }

  const fetchedCache = await fetchOpenRouterModels()
  if (!fetchedCache) return

  cache = fetchedCache
  await writeCache(fetchedCache)
}

export function getCachedOpenRouterContextWindow(provider: string, model: string): number | null {
  if (provider !== 'openrouter' || !isFreshCache(cache)) return null

  const exactMatch = cache.models[model]
  if (exactMatch) return exactMatch

  if (model.includes('/')) return null

  const suffixMatches = Object.entries(cache.models)
    .filter(([id]) => id.endsWith(`/${model}`))
    .map(([, contextLength]) => contextLength)

  return suffixMatches.length === 1 ? suffixMatches[0] : null
}

export async function ensureOpenRouterModelContextCache(provider: string): Promise<void> {
  if (provider !== 'openrouter' || isFreshCache(cache)) return

  if (!loading) {
    loading = loadOpenRouterModelContextCache().finally(() => {
      loading = null
    })
  }

  await loading
}
