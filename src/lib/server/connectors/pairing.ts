import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSenderId, senderMatchesAnyEntry } from '@/lib/connectors/sender-id'
import type { ConnectorDmAddressingMode, WhatsAppApprovedContact } from '@/types'
import { CONNECTORS_DATA_DIR } from '../data-dir'
import { safeJsonParseObject } from '../json-utils'

export {
  findMatchingSenderEntry,
  normalizeSenderId,
  senderIdVariants,
  senderMatchesAnyEntry,
} from '@/lib/connectors/sender-id'

const STORE_VERSION = 1
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const MAX_PENDING_PER_CONNECTOR = 100
const PAIR_CODE_LENGTH = 8
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function resolveStorePath(): string {
  return path.join(CONNECTORS_DATA_DIR, 'pairing-store.json')
}

export type PairingPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled'

export interface PairingRequest {
  code: string
  senderId: string
  senderName?: string
  channelId?: string
  createdAt: number
  updatedAt: number
}

export interface SenderAddressingOverride {
  senderId: string
  dmAddressingMode: ConnectorDmAddressingMode
}

interface ConnectorPairingState {
  allowedSenderIds: string[]
  pending: PairingRequest[]
  senderAddressingOverrides: SenderAddressingOverride[]
}

interface PairingStore {
  version: number
  connectors: Record<string, ConnectorPairingState>
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const normalized = normalizeSenderId(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function normalizeApprovedContactPhone(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeApprovedContactLabel(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || fallback
}

function approvedContactKey(phone: string): string {
  const normalized = normalizeSenderId(phone)
  if (!normalized) return ''
  const digits = normalized.replace(/[^\d]/g, '')
  if (digits) return digits
  const jidUser = normalized.split('@')[0]?.split(':')[0]?.trim()
  return jidUser || normalized
}

function prunePending(entries: PairingRequest[]): PairingRequest[] {
  const now = Date.now()
  return entries.filter((entry) => {
    if (!entry?.code || !entry?.senderId) return false
    if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) return false
    return (now - entry.updatedAt) <= PENDING_TTL_MS
  }).slice(-MAX_PENDING_PER_CONNECTOR)
}

function dedupeSenderAddressingOverrides(entries: SenderAddressingOverride[]): SenderAddressingOverride[] {
  const out: SenderAddressingOverride[] = []
  for (const entry of entries) {
    const normalizedSenderId = normalizeSenderId(entry.senderId)
    const dmAddressingMode = parseDmAddressingMode(entry.dmAddressingMode, 'open')
    if (!normalizedSenderId) continue
    const existingIndex = out.findIndex((item) => senderMatchesAnyEntry(normalizedSenderId, [item.senderId]))
    const nextEntry = { senderId: normalizedSenderId, dmAddressingMode }
    if (existingIndex >= 0) out[existingIndex] = nextEntry
    else out.push(nextEntry)
  }
  return out
}

function emptyStore(): PairingStore {
  return { version: STORE_VERSION, connectors: {} }
}

function loadStore(): PairingStore {
  const storePath = resolveStorePath()
  try {
    if (!fs.existsSync(storePath)) return emptyStore()
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = safeJsonParseObject<PairingStore>(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.connectors !== 'object') {
      return emptyStore()
    }

    const normalized: PairingStore = emptyStore()
    for (const [connectorId, value] of Object.entries(parsed.connectors || {})) {
      const state = value as Partial<ConnectorPairingState>
      const allowedSenderIds = dedupe(Array.isArray(state.allowedSenderIds) ? state.allowedSenderIds.map(String) : [])
      const pending = prunePending(Array.isArray(state.pending) ? state.pending as PairingRequest[] : [])
      const senderAddressingOverrides = dedupeSenderAddressingOverrides(
        Array.isArray(state.senderAddressingOverrides)
          ? state.senderAddressingOverrides
            .filter((entry): entry is Partial<SenderAddressingOverride> => !!entry && typeof entry === 'object')
            .map((entry) => ({
              senderId: String(entry.senderId || ''),
              dmAddressingMode: parseDmAddressingMode(entry.dmAddressingMode, 'open'),
            }))
          : [],
      )
      normalized.connectors[connectorId] = { allowedSenderIds, pending, senderAddressingOverrides }
    }
    return normalized
  } catch {
    return emptyStore()
  }
}

function saveStore(store: PairingStore): void {
  const storePath = resolveStorePath()
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`)
}

function ensureConnectorState(store: PairingStore, connectorId: string): ConnectorPairingState {
  const existing = store.connectors[connectorId]
  if (existing) {
    existing.allowedSenderIds = dedupe(existing.allowedSenderIds || [])
    existing.pending = prunePending(existing.pending || [])
    existing.senderAddressingOverrides = dedupeSenderAddressingOverrides(existing.senderAddressingOverrides || [])
    return existing
  }
  const created: ConnectorPairingState = {
    allowedSenderIds: [],
    pending: [],
    senderAddressingOverrides: [],
  }
  store.connectors[connectorId] = created
  return created
}

function randomPairCode(existing: Set<string>): string {
  for (let i = 0; i < 256; i++) {
    const bytes = crypto.randomBytes(PAIR_CODE_LENGTH)
    let out = ''
    for (let j = 0; j < PAIR_CODE_LENGTH; j++) {
      out += PAIR_CODE_ALPHABET[bytes[j] % PAIR_CODE_ALPHABET.length]
    }
    if (!existing.has(out)) return out
  }
  throw new Error('Unable to generate unique pairing code')
}

export function parsePairingPolicy(value: unknown, fallback: PairingPolicy = 'open'): PairingPolicy {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'open' || normalized === 'allowlist' || normalized === 'pairing' || normalized === 'disabled') {
    return normalized
  }
  return fallback
}

export function parseDmAddressingMode(
  value: unknown,
  fallback: ConnectorDmAddressingMode = 'open',
): ConnectorDmAddressingMode {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'open' || normalized === 'addressed') return normalized
  return fallback
}

export function parseAllowFromCsv(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return dedupe(value.split(',').map((item) => item.trim()).filter(Boolean))
}

export function normalizeWhatsAppApprovedContacts(value: unknown): WhatsAppApprovedContact[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const out: WhatsAppApprovedContact[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const phone = normalizeApprovedContactPhone(record.phone)
    if (!phone) continue
    const dedupeKey = approvedContactKey(phone)
    if (!dedupeKey || seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `wa-contact-${out.length + 1}`,
      label: normalizeApprovedContactLabel(record.label, phone),
      phone,
    })
  }
  return out
}

export function getWhatsAppApprovedSenderIds(value: unknown): string[] {
  return normalizeWhatsAppApprovedContacts(value).map((entry) => entry.phone)
}

export function listStoredAllowedSenders(connectorId: string): string[] {
  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  return state.allowedSenderIds.slice()
}

export function listPendingPairingRequests(connectorId: string): PairingRequest[] {
  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  return state.pending.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function listSenderAddressingOverrides(connectorId: string): SenderAddressingOverride[] {
  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  return state.senderAddressingOverrides.slice()
}

export function addAllowedSender(connectorId: string, senderId: string): { added: boolean; normalized: string } {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return { added: false, normalized }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const hasExisting = senderMatchesAnyEntry(normalized, state.allowedSenderIds)
  if (!hasExisting) {
    state.allowedSenderIds.push(normalized)
    state.allowedSenderIds = dedupe(state.allowedSenderIds)
  }

  // Remove any pending requests for the same sender after approval.
  state.pending = state.pending.filter((entry) => !senderMatchesAnyEntry(normalized, [entry.senderId]))

  saveStore(store)
  return { added: !hasExisting, normalized }
}

export function removeAllowedSender(connectorId: string, senderId: string): { removed: boolean; normalized: string } {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return { removed: false, normalized }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const nextAllowed = state.allowedSenderIds.filter((entry) => !senderMatchesAnyEntry(normalized, [entry]))
  const removed = nextAllowed.length !== state.allowedSenderIds.length
  if (removed) {
    state.allowedSenderIds = nextAllowed
    saveStore(store)
  }
  return { removed, normalized }
}

export function createOrTouchPairingRequest(params: {
  connectorId: string
  senderId: string
  senderName?: string
  channelId?: string
}): { code: string; created: boolean } {
  const normalized = normalizeSenderId(params.senderId)
  if (!normalized) throw new Error('senderId is required')

  const store = loadStore()
  const state = ensureConnectorState(store, params.connectorId)
  const now = Date.now()

  const existing = state.pending.find((entry) => normalizeSenderId(entry.senderId) === normalized)
  if (existing) {
    existing.updatedAt = now
    existing.senderName = params.senderName || existing.senderName
    existing.channelId = params.channelId || existing.channelId
    saveStore(store)
    return { code: existing.code, created: false }
  }

  const existingCodes = new Set(state.pending.map((entry) => entry.code.toUpperCase()))
  const code = randomPairCode(existingCodes)
  state.pending.push({
    code,
    senderId: normalized,
    senderName: params.senderName,
    channelId: params.channelId,
    createdAt: now,
    updatedAt: now,
  })
  state.pending = prunePending(state.pending)
  saveStore(store)
  return { code, created: true }
}

export function approvePairingCode(connectorId: string, codeRaw: string): {
  ok: boolean
  senderId?: string
  senderName?: string
  reason?: string
} {
  const code = codeRaw.trim().toUpperCase()
  if (!code) return { ok: false, reason: 'Missing code' }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const idx = state.pending.findIndex((entry) => entry.code.toUpperCase() === code)
  if (idx < 0) return { ok: false, reason: 'Code not found or expired' }

  const pending = state.pending[idx]
  state.pending.splice(idx, 1)

  const normalizedSender = normalizeSenderId(pending.senderId)
  if (!state.allowedSenderIds.includes(normalizedSender)) {
    state.allowedSenderIds.push(normalizedSender)
    state.allowedSenderIds = dedupe(state.allowedSenderIds)
  }

  saveStore(store)
  return {
    ok: true,
    senderId: normalizedSender,
    senderName: pending.senderName,
  }
}

export function findPendingPairingRequest(connectorId: string, senderId: string): PairingRequest | null {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return null
  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  return state.pending.find((entry) => senderMatchesAnyEntry(normalized, [entry.senderId])) || null
}

export function approvePendingSender(connectorId: string, senderId: string): {
  ok: boolean
  senderId?: string
  senderName?: string
  reason?: string
} {
  const pending = findPendingPairingRequest(connectorId, senderId)
  if (!pending) return { ok: false, reason: 'Pending request not found or expired' }
  return approvePairingCode(connectorId, pending.code)
}

export function rejectPendingSender(connectorId: string, senderId: string): { removed: boolean; normalized: string } {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return { removed: false, normalized }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const nextPending = state.pending.filter((entry) => !senderMatchesAnyEntry(normalized, [entry.senderId]))
  const removed = nextPending.length !== state.pending.length
  if (removed) {
    state.pending = nextPending
    saveStore(store)
  }
  return { removed, normalized }
}

export function getSenderAddressingOverride(
  connectorId: string,
  senderId: string | string[],
): ConnectorDmAddressingMode | null {
  const senderIds = Array.isArray(senderId) ? senderId : [senderId]
  const normalizedIds = senderIds.map((entry) => normalizeSenderId(entry)).filter(Boolean)
  if (normalizedIds.length === 0) return null
  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const match = state.senderAddressingOverrides.find((entry) => senderMatchesAnyEntry(normalizedIds, [entry.senderId]))
  return match?.dmAddressingMode || null
}

export function setSenderAddressingOverride(
  connectorId: string,
  senderId: string,
  dmAddressingMode: ConnectorDmAddressingMode,
): { changed: boolean; normalized: string } {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return { changed: false, normalized }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const nextMode = parseDmAddressingMode(dmAddressingMode, 'open')
  const existingIndex = state.senderAddressingOverrides.findIndex((entry) => senderMatchesAnyEntry(normalized, [entry.senderId]))
  if (existingIndex >= 0 && state.senderAddressingOverrides[existingIndex]?.dmAddressingMode === nextMode) {
    return { changed: false, normalized }
  }
  if (existingIndex >= 0) state.senderAddressingOverrides[existingIndex] = { senderId: normalized, dmAddressingMode: nextMode }
  else state.senderAddressingOverrides.push({ senderId: normalized, dmAddressingMode: nextMode })
  state.senderAddressingOverrides = dedupeSenderAddressingOverrides(state.senderAddressingOverrides)
  saveStore(store)
  return { changed: true, normalized }
}

export function clearSenderAddressingOverride(connectorId: string, senderId: string): { removed: boolean; normalized: string } {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return { removed: false, normalized }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const nextOverrides = state.senderAddressingOverrides.filter((entry) => !senderMatchesAnyEntry(normalized, [entry.senderId]))
  const removed = nextOverrides.length !== state.senderAddressingOverrides.length
  if (removed) {
    state.senderAddressingOverrides = nextOverrides
    saveStore(store)
  }
  return { removed, normalized }
}

export function isSenderAllowed(params: {
  connectorId: string
  senderId: string
  configAllowFrom?: string[]
}): boolean {
  if (senderMatchesAnyEntry(params.senderId, params.configAllowFrom || [])) return true

  const store = loadStore()
  const state = ensureConnectorState(store, params.connectorId)
  return senderMatchesAnyEntry(params.senderId, state.allowedSenderIds)
}

export function clearConnectorPairingState(connectorId: string): void {
  const store = loadStore()
  if (!store.connectors[connectorId]) return
  delete store.connectors[connectorId]
  saveStore(store)
}
