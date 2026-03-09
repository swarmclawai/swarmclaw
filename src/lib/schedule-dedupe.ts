import { CronExpressionParser } from 'cron-parser'
import type { ScheduleType } from '@/types'
import { dedup } from '@/lib/shared-utils'

export type ScheduleLike = {
  id?: string
  name?: string | null
  agentId?: string | null
  taskPrompt?: string | null
  scheduleType?: ScheduleType | string | null
  cron?: string | null
  intervalMs?: number | null
  runAt?: number | null
  status?: string | null
  updatedAt?: number | null
  createdAt?: number | null
  createdByAgentId?: string | null
  createdInSessionId?: string | null
}

export interface ScheduleDuplicateCandidate {
  id?: string | null
  agentId?: string | null
  taskPrompt?: string | null
  scheduleType?: ScheduleType | string | null
  cron?: string | null
  intervalMs?: number | null
  runAt?: number | null
  createdByAgentId?: string | null
  createdInSessionId?: string | null
}

export interface FindDuplicateScheduleOptions {
  ignoreId?: string | null
  includeStatuses?: string[]
  creatorScope?: {
    agentId?: string | null
    sessionId?: string | null
  } | null
}

interface ScheduleSignature {
  id: string
  agentId: string
  taskPrompt: string
  promptTokens: string[]
  scheduleType: ScheduleType
  cron: string
  intervalMs: number | null
  runAt: number | null
}

type ScheduleMatchKind = 'exact' | 'fuzzy'

const PROMPT_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'at',
  'back',
  'by',
  'check',
  'for',
  'from',
  'if',
  'in',
  'into',
  'me',
  'my',
  'of',
  'on',
  'once',
  'please',
  'remind',
  'report',
  'task',
  'the',
  'this',
  'to',
  'up',
  'update',
  'updates',
  'with',
])

const ONCE_MATCH_WINDOW_MS = 15 * 60 * 1000

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePrompt(value: unknown): string {
  const text = normalizeString(value)
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizePromptToken(token: string): string {
  let normalized = token
  if (normalized.length > 4 && normalized.endsWith('ies')) normalized = `${normalized.slice(0, -3)}y`
  else if (normalized.length > 5 && normalized.endsWith('ing')) normalized = normalized.slice(0, -3)
  else if (normalized.length > 4 && normalized.endsWith('ed')) normalized = normalized.slice(0, -2)
  else if (normalized.length > 3 && normalized.endsWith('s') && !normalized.endsWith('ss')) normalized = normalized.slice(0, -1)
  return normalized
}

function tokenizePrompt(value: unknown): string[] {
  const normalized = normalizePrompt(value).replace(/[^a-z0-9]+/g, ' ')
  if (!normalized) return []
  return normalized
    .split(' ')
    .map((token) => normalizePromptToken(token.trim()))
    .filter((token) => token.length > 0)
    .filter((token) => token.length > 2 || ['ai', 'uk', 'us', 'eu'].includes(token))
    .filter((token) => !PROMPT_STOPWORDS.has(token))
}

function normalizeCron(value: unknown): string {
  const cron = normalizeString(value)
  if (!cron) return ''
  return cron.replace(/\s+/g, ' ').trim()
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  const intVal = Math.trunc(parsed)
  return intVal > 0 ? intVal : null
}

function normalizeScheduleType(value: unknown): ScheduleType {
  if (value === 'cron' || value === 'once' || value === 'interval') return value
  return 'interval'
}

function toSignature(raw: ScheduleLike | ScheduleDuplicateCandidate): ScheduleSignature {
  return {
    id: normalizeString(raw.id),
    agentId: normalizeString(raw.agentId),
    taskPrompt: normalizePrompt(raw.taskPrompt),
    promptTokens: tokenizePrompt(raw.taskPrompt),
    scheduleType: normalizeScheduleType(raw.scheduleType),
    cron: normalizeCron(raw.cron),
    intervalMs: normalizePositiveInt(raw.intervalMs),
    runAt: normalizePositiveInt(raw.runAt),
  }
}

function cadenceKey(signature: ScheduleSignature): string {
  if (signature.scheduleType === 'cron') return `cron:${signature.cron || ''}`
  if (signature.scheduleType === 'interval') return `interval:${signature.intervalMs ?? ''}`
  if (signature.scheduleType === 'once') return `once:${signature.runAt ?? ''}`
  return signature.scheduleType
}

export function getScheduleSignatureKey(input: ScheduleLike | ScheduleDuplicateCandidate): string {
  const signature = toSignature(input)
  if (!signature.agentId || !signature.taskPrompt) return ''
  if (!sameCadence(signature, signature)) return ''
  return `${signature.agentId}::${signature.taskPrompt}::${signature.scheduleType}::${cadenceKey(signature)}`
}

function sameCadence(a: ScheduleSignature, b: ScheduleSignature): boolean {
  if (a.scheduleType !== b.scheduleType) return false
  if (a.scheduleType === 'cron') return a.cron !== '' && a.cron === b.cron
  if (a.scheduleType === 'interval') return a.intervalMs != null && a.intervalMs === b.intervalMs
  if (a.scheduleType === 'once') {
    if (a.runAt == null || b.runAt == null) return false
    return Math.abs(a.runAt - b.runAt) <= 1000
  }
  return false
}

function tryResolveCronIntervalMs(cron: string): number | null {
  if (!cron) return null
  try {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: new Date('2026-01-01T00:00:00.000Z'),
    })
    const first = interval.next().getTime()
    const second = interval.next().getTime()
    const diff = second - first
    return diff > 0 ? diff : null
  } catch {
    return null
  }
}

function cadenceFamilyFromMs(intervalMs: number | null): string {
  if (intervalMs == null || intervalMs <= 0) return ''

  const families: Array<{ label: string; ms: number; toleranceMs: number }> = [
    { label: '15m', ms: 15 * 60 * 1000, toleranceMs: 60 * 1000 },
    { label: '30m', ms: 30 * 60 * 1000, toleranceMs: 2 * 60 * 1000 },
    { label: 'hourly', ms: 60 * 60 * 1000, toleranceMs: 5 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000, toleranceMs: 15 * 60 * 1000 },
    { label: '12h', ms: 12 * 60 * 60 * 1000, toleranceMs: 30 * 60 * 1000 },
    { label: 'daily', ms: 24 * 60 * 60 * 1000, toleranceMs: 60 * 60 * 1000 },
    { label: 'weekly', ms: 7 * 24 * 60 * 60 * 1000, toleranceMs: 2 * 60 * 60 * 1000 },
  ]

  for (const family of families) {
    if (Math.abs(intervalMs - family.ms) <= family.toleranceMs) return family.label
  }

  return `interval:${Math.round(intervalMs / 60_000)}m`
}

function cadenceFamily(signature: ScheduleSignature): string {
  if (signature.scheduleType === 'once') return signature.runAt != null ? 'once' : ''
  if (signature.scheduleType === 'interval') return cadenceFamilyFromMs(signature.intervalMs)
  if (signature.scheduleType === 'cron') return cadenceFamilyFromMs(tryResolveCronIntervalMs(signature.cron))
  return ''
}

function sameCadenceFamily(a: ScheduleSignature, b: ScheduleSignature): boolean {
  if (sameCadence(a, b)) return true
  if (a.scheduleType === 'once' && b.scheduleType === 'once') {
    if (a.runAt == null || b.runAt == null) return false
    return Math.abs(a.runAt - b.runAt) <= ONCE_MATCH_WINDOW_MS
  }
  if (a.scheduleType === 'once' || b.scheduleType === 'once') return false
  const aFamily = cadenceFamily(a)
  const bFamily = cadenceFamily(b)
  return aFamily !== '' && aFamily === bFamily
}

function countTokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const smaller = a.length <= b.length ? a : b
  const largerSet = new Set(a.length <= b.length ? b : a)
  let overlap = 0
  for (const token of new Set(smaller)) {
    if (largerSet.has(token)) overlap += 1
  }
  return overlap
}

function hasFuzzyPromptMatch(a: ScheduleSignature, b: ScheduleSignature): boolean {
  if (!a.promptTokens.length || !b.promptTokens.length) return false
  const uniqueA = dedup(a.promptTokens)
  const uniqueB = dedup(b.promptTokens)
  const overlap = countTokenOverlap(uniqueA, uniqueB)
  if (overlap === 0) return false
  const smallerSize = Math.min(uniqueA.length, uniqueB.length)
  const largerSize = Math.max(uniqueA.length, uniqueB.length)
  const coverage = overlap / smallerSize
  const jaccard = overlap / new Set([...uniqueA, ...uniqueB]).size
  if (smallerSize <= 2) return overlap === smallerSize
  return overlap >= 2 && coverage >= 0.67 && (jaccard >= 0.5 || overlap >= Math.max(2, largerSize - 1))
}

function isEligibleStatus(status: unknown, includeStatuses: Set<string>): boolean {
  const normalized = normalizeString(status).toLowerCase() || 'active'
  return includeStatuses.has(normalized)
}

function matchesCreatorScope(
  schedule: ScheduleLike,
  scope: FindDuplicateScheduleOptions['creatorScope'],
): boolean {
  if (!scope) return true
  const scopeAgent = normalizeString(scope.agentId)
  const scopeSession = normalizeString(scope.sessionId)
  if (!scopeAgent && !scopeSession) return true

  const existingAgent = normalizeString(schedule.createdByAgentId)
  const existingSession = normalizeString(schedule.createdInSessionId)

  if (scopeAgent && existingAgent && scopeAgent !== existingAgent) return false
  if (scopeSession && existingSession && scopeSession !== existingSession) return false
  return true
}

function compareUpdatedDesc(a: ScheduleLike, b: ScheduleLike): number {
  const aTs = typeof a.updatedAt === 'number' ? a.updatedAt : (typeof a.createdAt === 'number' ? a.createdAt : 0)
  const bTs = typeof b.updatedAt === 'number' ? b.updatedAt : (typeof b.createdAt === 'number' ? b.createdAt : 0)
  return bTs - aTs
}

export function findDuplicateSchedule(
  schedules: Record<string, ScheduleLike>,
  candidateRaw: ScheduleDuplicateCandidate,
  opts: FindDuplicateScheduleOptions = {},
): ScheduleLike | null {
  return findEquivalentSchedules(schedules, candidateRaw, opts)[0] || null
}

export function findEquivalentSchedules(
  schedules: Record<string, ScheduleLike>,
  candidateRaw: ScheduleDuplicateCandidate,
  opts: FindDuplicateScheduleOptions = {},
): ScheduleLike[] {
  const candidate = toSignature(candidateRaw)
  if (!candidate.agentId) return []
  if (!candidate.taskPrompt) return []

  const ignoreId = normalizeString(opts.ignoreId || candidate.id)
  const statuses = new Set((opts.includeStatuses?.length ? opts.includeStatuses : ['active', 'paused']).map((s) => s.toLowerCase()))
  const scopeSessionId = normalizeString(opts.creatorScope?.sessionId)

  const matches = Object.values(schedules)
    .filter((existing) => existing && typeof existing === 'object')
    .map((existing) => {
      const signature = toSignature(existing)
      if (!signature.id) return null
      if (ignoreId && signature.id === ignoreId) return null
      if (!isEligibleStatus(existing.status, statuses)) return null
      if (!matchesCreatorScope(existing, opts.creatorScope || null)) return null
      if (signature.agentId !== candidate.agentId) return null
      const exact = signature.taskPrompt === candidate.taskPrompt && sameCadence(signature, candidate)
      if (exact) return { existing, kind: 'exact' as const }
      const fuzzy = Boolean(scopeSessionId)
        && hasFuzzyPromptMatch(signature, candidate)
        && sameCadenceFamily(signature, candidate)
      if (!fuzzy) return null
      return { existing, kind: 'fuzzy' as const }
    })
    .filter((entry): entry is { existing: ScheduleLike; kind: ScheduleMatchKind } => Boolean(entry))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'exact' ? -1 : 1
      return compareUpdatedDesc(a.existing, b.existing)
    })
    .map((entry) => entry.existing)

  return matches
}
