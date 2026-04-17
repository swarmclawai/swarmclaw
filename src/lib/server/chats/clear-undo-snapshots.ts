import type { Message } from '@/types'
import { hmrSingleton } from '@/lib/shared-utils'
import { genId } from '@/lib/id'

export const CLEAR_UNDO_TTL_MS = 30_000
const MAX_SNAPSHOTS = 200

export interface ClearUndoCliIds {
  claudeSessionId: string | null
  codexThreadId: string | null
  opencodeSessionId: string | null
  opencodeWebSessionId: string | null
  geminiSessionId: string | null
  copilotSessionId: string | null
  droidSessionId: string | null
  cursorSessionId: string | null
  qwenSessionId: string | null
  acpSessionId: string | null
  delegateResumeIds?: Record<string, string | null> | null
}

export interface ClearUndoSnapshot {
  sessionId: string
  messages: Message[]
  cli: ClearUndoCliIds
  createdAt: number
  expiresAt: number
}

const snapshots = hmrSingleton(
  'swarmclaw:clearUndoSnapshots',
  () => new Map<string, ClearUndoSnapshot>(),
)

function sweepExpired(now: number): void {
  if (snapshots.size === 0) return
  for (const [token, snapshot] of snapshots) {
    if (snapshot.expiresAt <= now) snapshots.delete(token)
  }
}

function enforceCap(): void {
  if (snapshots.size <= MAX_SNAPSHOTS) return
  const entries = [...snapshots.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
  const excess = snapshots.size - MAX_SNAPSHOTS
  for (let i = 0; i < excess; i++) snapshots.delete(entries[i][0])
}

export function recordClearUndoSnapshot(params: {
  sessionId: string
  messages: Message[]
  cli: ClearUndoCliIds
  now?: number
}): { token: string; expiresAt: number } {
  const now = typeof params.now === 'number' ? params.now : Date.now()
  sweepExpired(now)
  const token = `undo_${genId(8)}`
  const expiresAt = now + CLEAR_UNDO_TTL_MS
  snapshots.set(token, {
    sessionId: params.sessionId,
    messages: params.messages,
    cli: params.cli,
    createdAt: now,
    expiresAt,
  })
  enforceCap()
  return { token, expiresAt }
}

export function consumeClearUndoSnapshot(params: {
  token: string
  sessionId: string
  now?: number
}): ClearUndoSnapshot | null {
  const now = typeof params.now === 'number' ? params.now : Date.now()
  sweepExpired(now)
  const snapshot = snapshots.get(params.token)
  if (!snapshot) return null
  if (snapshot.sessionId !== params.sessionId) {
    return null
  }
  if (snapshot.expiresAt <= now) {
    snapshots.delete(params.token)
    return null
  }
  snapshots.delete(params.token)
  return snapshot
}

export function __resetClearUndoSnapshotsForTests(): void {
  snapshots.clear()
}
