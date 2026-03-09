import fs from 'fs'
import path from 'path'
import type { BrowserObservation, BrowserSessionRecord, Session } from '@/types'
import { BROWSER_PROFILES_DIR } from './data-dir'
import { resolvePathWithinBaseDir } from './path-utils'
import {
  deleteBrowserSession,
  loadBrowserSessions,
  loadSessions,
  saveSessions,
  upsertBrowserSession,
} from './storage'

function sanitizeToken(value: string): string {
  const trimmed = value.trim()
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return safe || 'default'
}

export function normalizeBrowserProfileId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? sanitizeToken(value) : ''
}

export function getBrowserProfileDir(profileId: string): string {
  if (!fs.existsSync(BROWSER_PROFILES_DIR)) fs.mkdirSync(BROWSER_PROFILES_DIR, { recursive: true })
  const dir = resolvePathWithinBaseDir(BROWSER_PROFILES_DIR, sanitizeToken(profileId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveBrowserProfileInfo(session: Session | Record<string, unknown> | null | undefined): {
  profileId: string
  inheritedFromSessionId: string | null
} {
  const current = session && typeof session === 'object' ? session as Record<string, unknown> : {}
  const direct = normalizeBrowserProfileId(current.browserProfileId)
  if (direct) return { profileId: direct, inheritedFromSessionId: null }

  const sessionId = typeof current.id === 'string' && current.id.trim() ? current.id.trim() : 'default'
  return { profileId: sanitizeToken(sessionId), inheritedFromSessionId: null }
}

export function ensureSessionBrowserProfileId(sessionId: string): {
  profileId: string
  inheritedFromSessionId: string | null
} {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) return { profileId: sanitizeToken(sessionId), inheritedFromSessionId: null }
  const resolved = resolveBrowserProfileInfo(session)
  if (session.browserProfileId !== resolved.profileId) {
    session.browserProfileId = resolved.profileId
    session.updatedAt = Date.now()
    sessions[sessionId] = session
    saveSessions(sessions)
  }
  return resolved
}

export function loadBrowserSessionRecord(sessionId: string): BrowserSessionRecord | null {
  const all = loadBrowserSessions()
  const raw = all[sessionId]
  if (!raw || typeof raw !== 'object') return null
  return raw as BrowserSessionRecord
}

function mergeArtifacts(current: BrowserSessionRecord['artifacts'], next: BrowserSessionRecord['artifacts']): BrowserSessionRecord['artifacts'] {
  const merged = [...(current || []), ...(next || [])]
  return merged.slice(-24)
}

export function upsertBrowserSessionRecord(input: Partial<BrowserSessionRecord> & { sessionId: string }): BrowserSessionRecord {
  const now = Date.now()
  const current = loadBrowserSessionRecord(input.sessionId)
  const baseProfile = input.profileId
    || current?.profileId
    || ensureSessionBrowserProfileId(input.sessionId).profileId
  const next: BrowserSessionRecord = {
    id: input.sessionId,
    sessionId: input.sessionId,
    profileId: baseProfile,
    profileDir: input.profileDir || current?.profileDir || getBrowserProfileDir(baseProfile),
    status: input.status || current?.status || 'idle',
    inheritedFromSessionId: input.inheritedFromSessionId ?? current?.inheritedFromSessionId ?? null,
    currentUrl: input.currentUrl ?? current?.currentUrl ?? null,
    pageTitle: input.pageTitle ?? current?.pageTitle ?? null,
    activeTabIndex: input.activeTabIndex ?? current?.activeTabIndex ?? null,
    tabs: input.tabs ?? current?.tabs ?? [],
    lastAction: input.lastAction ?? current?.lastAction ?? null,
    lastError: input.lastError ?? current?.lastError ?? null,
    lastObservation: input.lastObservation ?? current?.lastObservation ?? null,
    artifacts: mergeArtifacts(current?.artifacts, input.artifacts),
    createdAt: current?.createdAt || input.createdAt || now,
    updatedAt: now,
    lastUsedAt: input.lastUsedAt || now,
  }
  upsertBrowserSession(next.id, next)
  return next
}

export function recordBrowserObservation(sessionId: string, observation: BrowserObservation): BrowserSessionRecord {
  return upsertBrowserSessionRecord({
    sessionId,
    currentUrl: observation.url ?? null,
    pageTitle: observation.title ?? null,
    activeTabIndex: observation.activeTabIndex ?? null,
    tabs: observation.tabs ?? [],
    lastObservation: observation,
  })
}

export function markBrowserSessionClosed(sessionId: string, error?: string | null): BrowserSessionRecord | null {
  const current = loadBrowserSessionRecord(sessionId)
  if (!current) return null
  return upsertBrowserSessionRecord({
    sessionId,
    status: error ? 'error' : 'closed',
    lastError: error ?? null,
  })
}

export function removeBrowserSessionRecord(sessionId: string): void {
  deleteBrowserSession(sessionId)
}
