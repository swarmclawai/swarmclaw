import crypto from 'node:crypto'
import type { AppSettings, Message } from '@/types'

export interface LlmResponseCacheConfig {
  enabled: boolean
  ttlMs: number
  maxEntries: number
}

export interface LlmResponseCacheKeyInput {
  provider: string
  model: string
  apiEndpoint?: string | null
  systemPrompt?: string
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  history: Message[]
}

export interface LlmResponseCacheHit {
  key: string
  text: string
  provider: string
  model: string
  createdAt: number
  ageMs: number
  hits: number
}

interface LlmResponseCacheEntry {
  key: string
  text: string
  provider: string
  model: string
  createdAt: number
  expiresAt: number
  hits: number
}

const DEFAULT_ENABLED = true
const DEFAULT_TTL_SEC = 15 * 60
const DEFAULT_MAX_ENTRIES = 500

const MIN_TTL_SEC = 5
const MAX_TTL_SEC = 7 * 24 * 3600
const MIN_ENTRIES = 1
const MAX_ENTRIES = 20_000

const responseCache = new Map<string, LlmResponseCacheEntry>()

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'number' || kind === 'boolean') return JSON.stringify(value)
  if (kind === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  if (kind === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

function normalizeHistory(history: Message[]): Array<Record<string, unknown>> {
  return history.map((entry) => ({
    role: entry.role,
    text: normalizeText(entry.text),
    kind: entry.kind || null,
    imagePath: entry.imagePath || null,
    imageUrl: entry.imageUrl || null,
    attachedFiles: normalizeList(entry.attachedFiles),
    replyToId: entry.replyToId || null,
  }))
}

function trimToCapacity(maxEntries: number): void {
  while (responseCache.size > maxEntries) {
    const oldestKey = responseCache.keys().next().value as string | undefined
    if (!oldestKey) break
    responseCache.delete(oldestKey)
  }
}

function moveToMostRecent(key: string, entry: LlmResponseCacheEntry): void {
  responseCache.delete(key)
  responseCache.set(key, entry)
}

export function resolveLlmResponseCacheConfig(
  settings?: AppSettings | Record<string, unknown> | null,
): LlmResponseCacheConfig {
  const raw = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {}
  const ttlSec = normalizeInt(raw.responseCacheTtlSec, DEFAULT_TTL_SEC, MIN_TTL_SEC, MAX_TTL_SEC)
  const maxEntries = normalizeInt(raw.responseCacheMaxEntries, DEFAULT_MAX_ENTRIES, MIN_ENTRIES, MAX_ENTRIES)
  const enabled = normalizeBool(raw.responseCacheEnabled, DEFAULT_ENABLED)
  return {
    enabled,
    ttlMs: ttlSec * 1000,
    maxEntries,
  }
}

export function buildLlmResponseCacheKey(input: LlmResponseCacheKeyInput): string {
  const payload = {
    provider: normalizeText(input.provider).toLowerCase(),
    model: normalizeText(input.model),
    apiEndpoint: normalizeText(input.apiEndpoint || ''),
    systemPrompt: normalizeText(input.systemPrompt || ''),
    message: normalizeText(input.message),
    imagePath: normalizeText(input.imagePath || ''),
    imageUrl: normalizeText(input.imageUrl || ''),
    attachedFiles: normalizeList(input.attachedFiles),
    history: normalizeHistory(Array.isArray(input.history) ? input.history : []),
  }
  const stable = stableStringify(payload)
  return crypto.createHash('sha256').update(stable).digest('hex')
}

export function getCachedLlmResponse(
  input: LlmResponseCacheKeyInput,
  config: LlmResponseCacheConfig,
  now = Date.now(),
): LlmResponseCacheHit | null {
  if (!config.enabled) return null
  const key = buildLlmResponseCacheKey(input)
  const found = responseCache.get(key)
  if (!found) return null
  if (now >= found.expiresAt) {
    responseCache.delete(key)
    return null
  }
  const next = { ...found, hits: found.hits + 1 }
  moveToMostRecent(key, next)
  return {
    key,
    text: next.text,
    provider: next.provider,
    model: next.model,
    createdAt: next.createdAt,
    ageMs: Math.max(0, now - next.createdAt),
    hits: next.hits,
  }
}

export function setCachedLlmResponse(
  input: LlmResponseCacheKeyInput,
  text: string,
  config: LlmResponseCacheConfig,
  now = Date.now(),
): void {
  if (!config.enabled) return
  const normalizedText = normalizeText(text)
  if (!normalizedText) return
  const key = buildLlmResponseCacheKey(input)
  const existing = responseCache.get(key)
  const createdAt = existing?.createdAt ?? now
  const entry: LlmResponseCacheEntry = {
    key,
    text: normalizedText,
    provider: normalizeText(input.provider).toLowerCase(),
    model: normalizeText(input.model),
    createdAt,
    expiresAt: now + config.ttlMs,
    hits: existing?.hits ?? 0,
  }
  moveToMostRecent(key, entry)
  trimToCapacity(config.maxEntries)
}

export function getLlmResponseCacheStats(now = Date.now()): {
  entries: number
  expired: number
  oldestAgeMs: number
} {
  let expired = 0
  let oldestCreatedAt = Number.POSITIVE_INFINITY
  for (const entry of responseCache.values()) {
    if (entry.expiresAt <= now) expired++
    oldestCreatedAt = Math.min(oldestCreatedAt, entry.createdAt)
  }
  const oldestAgeMs = Number.isFinite(oldestCreatedAt) ? Math.max(0, now - oldestCreatedAt) : 0
  return {
    entries: responseCache.size,
    expired,
    oldestAgeMs,
  }
}

export function clearLlmResponseCache(): void {
  responseCache.clear()
}
