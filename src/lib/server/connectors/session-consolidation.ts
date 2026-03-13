/**
 * One-time migration: backfill allKnownPeerIds on existing connector sessions.
 * Populates the field from existing senderId, senderIdAlt, channelId, channelIdAlt, peerKey.
 */
import { loadSessions, loadSettings, saveSettings, upsertStoredItem } from '../storage'
import type { Session } from '@/types'
import { isDirectConnectorSession } from './session-kind'

const ALL_KNOWN_PEER_IDS_MIGRATION_FLAG = '_migration_allKnownPeerIds'
const THREAD_CONNECTOR_MIRROR_CLEANUP_FLAG = '_migration_pruneThreadConnectorMirrors'

export function backfillAllKnownPeerIds(): { migrated: number; skipped: boolean } {
  const settings = loadSettings()
  if (settings[ALL_KNOWN_PEER_IDS_MIGRATION_FLAG]) {
    return { migrated: 0, skipped: true }
  }

  const sessions = loadSessions() as Record<string, Session>
  let migrated = 0

  for (const session of Object.values(sessions)) {
    if (!isDirectConnectorSession(session)) continue
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
  updated[ALL_KNOWN_PEER_IDS_MIGRATION_FLAG] = true
  saveSettings(updated)
  if (migrated > 0) {
    console.log(`[session-consolidation] Backfilled allKnownPeerIds on ${migrated} sessions`)
  }
  return { migrated, skipped: false }
}

export function pruneThreadConnectorMirrors(): { cleanedSessions: number; removedMessages: number; skipped: boolean } {
  const settings = loadSettings()
  if (settings[THREAD_CONNECTOR_MIRROR_CLEANUP_FLAG]) {
    return { cleanedSessions: 0, removedMessages: 0, skipped: true }
  }

  const sessions = loadSessions() as Record<string, Session>
  let cleanedSessions = 0
  let removedMessages = 0

  for (const session of Object.values(sessions)) {
    if (isDirectConnectorSession(session)) continue
    if (!Array.isArray(session.messages) || session.messages.length === 0) continue

    const filteredMessages = session.messages.filter((message) => !(
      message?.historyExcluded === true
      && typeof message?.source?.connectorId === 'string'
      && message.source.connectorId.trim().length > 0
    ))

    const removed = session.messages.length - filteredMessages.length
    if (removed <= 0) continue

    session.messages = filteredMessages
    upsertStoredItem('sessions', session.id, session)
    cleanedSessions += 1
    removedMessages += removed
  }

  const updated = loadSettings()
  updated[THREAD_CONNECTOR_MIRROR_CLEANUP_FLAG] = true
  saveSettings(updated)
  if (removedMessages > 0) {
    console.log(`[session-consolidation] Pruned ${removedMessages} mirrored connector message(s) from ${cleanedSessions} main session(s)`)
  }
  return { cleanedSessions, removedMessages, skipped: false }
}
