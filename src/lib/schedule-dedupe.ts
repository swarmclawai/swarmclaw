import type { ScheduleType } from '@/types'

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
  scheduleType: ScheduleType
  cron: string
  intervalMs: number | null
  runAt: number | null
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePrompt(value: unknown): string {
  const text = normalizeString(value)
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
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
  const candidate = toSignature(candidateRaw)
  if (!candidate.agentId) return null
  if (!candidate.taskPrompt) return null

  const ignoreId = normalizeString(opts.ignoreId || candidate.id)
  const statuses = new Set((opts.includeStatuses?.length ? opts.includeStatuses : ['active', 'paused']).map((s) => s.toLowerCase()))

  const matches = Object.values(schedules)
    .filter((existing) => existing && typeof existing === 'object')
    .filter((existing) => {
      const signature = toSignature(existing)
      if (!signature.id) return false
      if (ignoreId && signature.id === ignoreId) return false
      if (!isEligibleStatus(existing.status, statuses)) return false
      if (!matchesCreatorScope(existing, opts.creatorScope || null)) return false
      if (signature.agentId !== candidate.agentId) return false
      if (signature.taskPrompt !== candidate.taskPrompt) return false
      return sameCadence(signature, candidate)
    })
    .sort(compareUpdatedDesc)

  return matches[0] || null
}
