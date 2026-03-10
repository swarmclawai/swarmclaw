/**
 * One-time migration: backfill allKnownPeerIds on existing connector sessions.
 * Populates the field from existing senderId, senderIdAlt, channelId, channelIdAlt, peerKey.
 */
import { loadSessions, loadSettings, saveSettings, upsertStoredItem } from '../storage'
import type { Session } from '@/types'

const MIGRATION_FLAG = '_migration_allKnownPeerIds'

export function backfillAllKnownPeerIds(): { migrated: number; skipped: boolean } {
  const settings = loadSettings()
  if (settings[MIGRATION_FLAG]) {
    return { migrated: 0, skipped: true }
  }

  const sessions = loadSessions() as Record<string, Session>
  let migrated = 0

  for (const session of Object.values(sessions)) {
    const ctx = session?.connectorContext
    if (!ctx?.connectorId) continue
    if (Array.isArray(ctx.allKnownPeerIds) && ctx.allKnownPeerIds.length > 0) continue

    const ids = new Set<string>()
    for (const val of [ctx.senderId, ctx.senderIdAlt, ctx.channelId, ctx.channelIdAlt, ctx.peerKey]) {
      if (typeof val === 'string' && val) ids.add(val)
    }

    if (ids.size === 0) continue

    session.connectorContext = {
      ...ctx,
      allKnownPeerIds: [...ids],
    }
    upsertStoredItem('sessions', session.id, session)
    migrated++
  }

  const updated = loadSettings()
  updated[MIGRATION_FLAG] = true
  saveSettings(updated)
  if (migrated > 0) {
    console.log(`[session-consolidation] Backfilled allKnownPeerIds on ${migrated} sessions`)
  }
  return { migrated, skipped: false }
}
