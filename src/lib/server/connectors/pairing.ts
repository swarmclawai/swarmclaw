import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data')
const STORE_VERSION = 1
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const MAX_PENDING_PER_CONNECTOR = 100
const PAIR_CODE_LENGTH = 8
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function resolveStorePath(): string {
  const dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR
  return path.join(dataDir, 'connectors', 'pairing-store.json')
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

interface ConnectorPairingState {
  allowedSenderIds: string[]
  pending: PairingRequest[]
}

interface PairingStore {
  version: number
  connectors: Record<string, ConnectorPairingState>
}

function normalizeSenderId(value: string): string {
  return value.trim().toLowerCase()
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

function prunePending(entries: PairingRequest[]): PairingRequest[] {
  const now = Date.now()
  return entries.filter((entry) => {
    if (!entry?.code || !entry?.senderId) return false
    if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) return false
    return (now - entry.updatedAt) <= PENDING_TTL_MS
  }).slice(-MAX_PENDING_PER_CONNECTOR)
}

function emptyStore(): PairingStore {
  return { version: STORE_VERSION, connectors: {} }
}

function loadStore(): PairingStore {
  const storePath = resolveStorePath()
  try {
    if (!fs.existsSync(storePath)) return emptyStore()
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(raw) as PairingStore
    if (!parsed || typeof parsed !== 'object' || typeof parsed.connectors !== 'object') {
      return emptyStore()
    }

    const normalized: PairingStore = emptyStore()
    for (const [connectorId, value] of Object.entries(parsed.connectors || {})) {
      const state = value as Partial<ConnectorPairingState>
      const allowedSenderIds = dedupe(Array.isArray(state.allowedSenderIds) ? state.allowedSenderIds.map(String) : [])
      const pending = prunePending(Array.isArray(state.pending) ? state.pending as PairingRequest[] : [])
      normalized.connectors[connectorId] = { allowedSenderIds, pending }
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
    return existing
  }
  const created: ConnectorPairingState = {
    allowedSenderIds: [],
    pending: [],
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

export function parseAllowFromCsv(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return dedupe(value.split(',').map((item) => item.trim()).filter(Boolean))
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

export function addAllowedSender(connectorId: string, senderId: string): { added: boolean; normalized: string } {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return { added: false, normalized }

  const store = loadStore()
  const state = ensureConnectorState(store, connectorId)
  const hasExisting = state.allowedSenderIds.includes(normalized)
  if (!hasExisting) {
    state.allowedSenderIds.push(normalized)
  }

  // Remove any pending requests for the same sender after approval.
  state.pending = state.pending.filter((entry) => normalizeSenderId(entry.senderId) !== normalized)

  saveStore(store)
  return { added: !hasExisting, normalized }
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

export function isSenderAllowed(params: {
  connectorId: string
  senderId: string
  configAllowFrom?: string[]
}): boolean {
  const normalized = normalizeSenderId(params.senderId)
  if (!normalized) return false

  const configSet = new Set((params.configAllowFrom || []).map((item) => normalizeSenderId(item)).filter(Boolean))
  if (configSet.has(normalized)) return true

  const store = loadStore()
  const state = ensureConnectorState(store, params.connectorId)
  return state.allowedSenderIds.includes(normalized)
}

export function clearConnectorPairingState(connectorId: string): void {
  const store = loadStore()
  if (!store.connectors[connectorId]) return
  delete store.connectors[connectorId]
  saveStore(store)
}
