import { genId } from '@/lib/id'
import {
  loadConnectorOutbox,
  patchStoredItem,
  upsertConnectorOutboxItem,
} from '../storage'
import { notify } from '../ws-hub'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'


export type ConnectorOutboxStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'suppressed'
  | 'failed'
  | 'cancelled'

export interface ConnectorOutboxEntry extends Record<string, unknown> {
  id: string
  status: ConnectorOutboxStatus
  sendAt: number
  createdAt: number
  updatedAt: number
  attemptCount: number
  maxAttempts: number
  /** Destination fields (set by enqueueConnectorOutbox) */
  connectorId?: string
  platform?: string
  channelId?: string
  text?: string
  sessionId?: string | null
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  ptt?: boolean
  dedupeKey?: string | null
  lastError?: string | null
  deliveredAt?: number | null
  lastMessageId?: string | null
  processingLeaseId?: string | null
  processingStartedAt?: number | null
}

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
const DEFAULT_MAX_ATTEMPTS = 6
const CLAIM_STALE_MS = 60_000
const MAX_BATCH_SIZE = 10

type OutboxState = {
  timer: ReturnType<typeof setTimeout> | null
  dueAt: number | null
  running: boolean
  pendingKick: boolean
}

const outboxState: OutboxState = hmrSingleton<OutboxState>('__swarmclaw_connector_outbox_state__', () => ({
  timer: null,
  dueAt: null,
  running: false,
  pendingKick: false,
}))

function normalizeEntry(value: unknown): ConnectorOutboxEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const channelId = typeof row.channelId === 'string' ? row.channelId : ''
  if (!id || !channelId) return null
  return {
    id,
    
    
    channelId,
    text: typeof row.text === 'string' ? row.text : '',
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    imageUrl: typeof row.imageUrl === 'string' ? row.imageUrl : undefined,
    fileUrl: typeof row.fileUrl === 'string' ? row.fileUrl : undefined,
    mediaPath: typeof row.mediaPath === 'string' ? row.mediaPath : undefined,
    mimeType: typeof row.mimeType === 'string' ? row.mimeType : undefined,
    fileName: typeof row.fileName === 'string' ? row.fileName : undefined,
    caption: typeof row.caption === 'string' ? row.caption : undefined,
    replyToMessageId: typeof row.replyToMessageId === 'string' ? row.replyToMessageId : undefined,
    threadId: typeof row.threadId === 'string' ? row.threadId : undefined,
    ptt: row.ptt === true,
    status: normalizeStatus(row.status),
    sendAt: typeof row.sendAt === 'number' ? row.sendAt : 0,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    attemptCount: typeof row.attemptCount === 'number' ? row.attemptCount : 0,
    maxAttempts: typeof row.maxAttempts === 'number' ? row.maxAttempts : DEFAULT_MAX_ATTEMPTS,
    dedupeKey: typeof row.dedupeKey === 'string' ? row.dedupeKey : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    deliveredAt: typeof row.deliveredAt === 'number' ? row.deliveredAt : null,
    lastMessageId: typeof row.lastMessageId === 'string' ? row.lastMessageId : null,
    processingLeaseId: typeof row.processingLeaseId === 'string' ? row.processingLeaseId : null,
    processingStartedAt: typeof row.processingStartedAt === 'number' ? row.processingStartedAt : null,
  }
}

function normalizeStatus(value: unknown): ConnectorOutboxStatus {
  switch (value) {
    case 'processing':
    case 'sent':
    case 'suppressed':
    case 'failed':
    case 'cancelled':
      return value
    default:
      return 'pending'
  }
}

function isTerminalStatus(status: ConnectorOutboxStatus): boolean {
  return status === 'sent' || status === 'suppressed' || status === 'failed' || status === 'cancelled'
}

function isClaimEligible(entry: ConnectorOutboxEntry, now: number): boolean {
  if (entry.status === 'pending') return entry.sendAt <= now
  if (entry.status !== 'processing') return false
  const startedAt = entry.processingStartedAt || entry.updatedAt || entry.sendAt || 0
  return now - startedAt >= CLAIM_STALE_MS
}

function listEntries(): ConnectorOutboxEntry[] {
  return Object.values(loadConnectorOutbox())
    .map((value) => normalizeEntry(value))
    .filter((value): value is ConnectorOutboxEntry => !!value)
}

function nextRetryAt(now: number, attemptCount: number): number {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attemptCount - 1)))
  return now + backoff
}

function scheduleTimer(delayMs: number): void {
  const nextDueAt = Date.now() + Math.max(0, delayMs)
  if (outboxState.timer && outboxState.dueAt !== null && outboxState.dueAt <= nextDueAt) return
  if (outboxState.timer) {
    clearTimeout(outboxState.timer)
    outboxState.timer = null
  }
  outboxState.dueAt = nextDueAt
  outboxState.timer = setTimeout(() => {
    outboxState.timer = null
    outboxState.dueAt = null
    void runConnectorOutboxNow().catch((err: unknown) => {
      console.warn(`[connector-outbox] Worker tick failed: ${errorMessage(err)}`)
    })
  }, Math.max(0, delayMs))
  outboxState.timer.unref?.()
}

function rescheduleFromStorage(now = Date.now()): void {
  const active = listEntries()
    .filter((entry) => !isTerminalStatus(entry.status))
    .sort((a, b) => a.sendAt - b.sendAt || a.createdAt - b.createdAt)
  if (!active.length) {
    if (outboxState.timer) {
      clearTimeout(outboxState.timer)
      outboxState.timer = null
    }
    outboxState.dueAt = null
    return
  }
  const nextDue = active[0].sendAt
  scheduleTimer(Math.max(0, nextDue - now))
}

function claimEntry(id: string, now: number): ConnectorOutboxEntry | null {
  const leaseId = `${now}:${Math.random().toString(16).slice(2, 10)}`
  const claimed = patchStoredItem<ConnectorOutboxEntry>('connector_outbox', id, (current) => {
    const entry = normalizeEntry(current)
    if (!entry) return current
    if (!isClaimEligible(entry, now)) return entry
    return {
      ...entry,
      status: 'processing',
      processingLeaseId: leaseId,
      processingStartedAt: now,
      updatedAt: now,
    }
  })
  const normalized = normalizeEntry(claimed)
  if (!normalized) return null
  if (normalized.status !== 'processing' || normalized.processingLeaseId !== leaseId) return null
  return normalized
}

async function processEntry(id: string, now: number): Promise<ConnectorOutboxEntry | null> {
  const claimed = claimEntry(id, now)
  if (!claimed) return null

  try {
    const { sendConnectorMessage } = await import('./manager')
    // Outbox entries always have channelId+text from enqueueConnectorOutbox
    const sendParams = {
      ...claimed,
      dedupeKey: claimed.dedupeKey || undefined,
    } as ConnectorOutboxEntry & { channelId: string; text: string; dedupeKey?: string }
    const result = await sendConnectorMessage(sendParams)
    const deliveredAt = Date.now()
    const next: ConnectorOutboxEntry = {
      ...claimed,
      connectorId: result.connectorId,
      platform: result.platform,
      channelId: result.channelId,
      status: result.suppressed ? 'suppressed' : 'sent',
      attemptCount: claimed.attemptCount + 1,
      updatedAt: deliveredAt,
      deliveredAt,
      lastMessageId: result.messageId || null,
      lastError: null,
      processingLeaseId: null,
      processingStartedAt: null,
    }
    upsertConnectorOutboxItem(next.id, next)
    notify('connector_outbox')
    return next
  } catch (err: unknown) {
    const failedAt = Date.now()
    const nextAttemptCount = claimed.attemptCount + 1
    const permanent = nextAttemptCount >= claimed.maxAttempts
    const next: ConnectorOutboxEntry = {
      ...claimed,
      status: permanent ? 'failed' : 'pending',
      attemptCount: nextAttemptCount,
      updatedAt: failedAt,
      sendAt: permanent ? claimed.sendAt : nextRetryAt(failedAt, nextAttemptCount),
      lastError: errorMessage(err),
      processingLeaseId: null,
      processingStartedAt: null,
    }
    upsertConnectorOutboxItem(next.id, next)
    notify('connector_outbox')
    return next
  }
}

export function enqueueConnectorOutbox(
  input: Record<string, unknown> & {
    sendAt?: number
    maxAttempts?: number
    dedupeKey?: string | null
  },
  options?: { replaceExisting?: boolean },
): { outboxId: string; sendAt: number } {
  const now = Date.now()
  const requestedSendAt = typeof input.sendAt === 'number' ? input.sendAt : now
  const sendAt = Math.max(now, requestedSendAt)
  const dedupeKey = input.dedupeKey?.trim() || null

  if (dedupeKey) {
    const existing = findPendingConnectorOutboxByDedupe(dedupeKey, now)
    if (existing && existing.sendAt > now && !options?.replaceExisting) {
      return { outboxId: existing.id, sendAt: existing.sendAt }
    }
    if (existing && options?.replaceExisting) {
      patchStoredItem<ConnectorOutboxEntry>('connector_outbox', existing.id, (current) => {
        const entry = normalizeEntry(current)
        if (!entry || isTerminalStatus(entry.status)) return entry
        return {
          ...entry,
          status: 'cancelled',
          updatedAt: now,
          processingLeaseId: null,
          processingStartedAt: null,
        }
      })
    }
  }

  const entry: ConnectorOutboxEntry = {
    ...input,
    id: genId(),
    status: 'pending',
    sendAt,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    maxAttempts: Math.max(1, Math.trunc(input.maxAttempts || DEFAULT_MAX_ATTEMPTS)),
    dedupeKey,
    lastError: null,
    deliveredAt: null,
    lastMessageId: null,
    processingLeaseId: null,
    processingStartedAt: null,
  }
  upsertConnectorOutboxItem(entry.id, entry)
  notify('connector_outbox')
  rescheduleFromStorage(now)
  return { outboxId: entry.id, sendAt: entry.sendAt }
}

export function findPendingConnectorOutboxByDedupe(dedupeKey: string, now = Date.now()): ConnectorOutboxEntry | null {
  const normalizedKey = dedupeKey.trim()
  if (!normalizedKey) return null
  return listEntries()
    .filter((entry) =>
      entry.dedupeKey === normalizedKey
      && !isTerminalStatus(entry.status)
      && (entry.sendAt > now || entry.status === 'processing'),
    )
    .sort((a, b) => a.sendAt - b.sendAt || a.createdAt - b.createdAt)[0] || null
}

export async function runConnectorOutboxNow(options?: {
  now?: number
  maxItems?: number
  onlyIds?: string[]
}): Promise<ConnectorOutboxEntry[]> {
  if (outboxState.running) {
    outboxState.pendingKick = true
    return []
  }

  outboxState.running = true
  const now = options?.now ?? Date.now()
  try {
    const onlyIds = new Set((options?.onlyIds || []).filter(Boolean))
    const candidates = listEntries()
      .filter((entry) => (onlyIds.size === 0 || onlyIds.has(entry.id)) && isClaimEligible(entry, now))
      .sort((a, b) => a.sendAt - b.sendAt || a.createdAt - b.createdAt)
      .slice(0, Math.max(1, options?.maxItems || MAX_BATCH_SIZE))

    const processed: ConnectorOutboxEntry[] = []
    for (const entry of candidates) {
      const next = await processEntry(entry.id, now)
      if (next) processed.push(next)
    }
    return processed
  } finally {
    outboxState.running = false
    if (outboxState.pendingKick) {
      outboxState.pendingKick = false
      scheduleTimer(0)
    } else {
      rescheduleFromStorage()
    }
  }
}

export function startConnectorOutboxWorker(): void {
  rescheduleFromStorage()
}

export function stopConnectorOutboxWorker(): void {
  if (outboxState.timer) {
    clearTimeout(outboxState.timer)
    outboxState.timer = null
  }
  outboxState.dueAt = null
  outboxState.pendingKick = false
}

export function getConnectorOutboxStatus(): {
  queued: number
  running: boolean
  nextDueAt: number | null
} {
  const queued = listEntries().filter((entry) => !isTerminalStatus(entry.status)).length
  return {
    queued,
    running: outboxState.running,
    nextDueAt: outboxState.dueAt,
  }
}
