/**
 * One-time migration: backfill allKnownPeerIds on existing connector sessions.
 * Populates the field from existing senderId, senderIdAlt, channelId, channelIdAlt, peerKey.
 */
import { log } from '@/lib/server/logger'
import { saveSession, loadSessions } from '@/lib/server/sessions/session-repository'
import { getMessages, getMessageCount, replaceAllMessages } from '@/lib/server/messages/message-repository'
import { loadSettings, saveSettings } from '../settings/settings-repository'
import type { Session } from '@/types'
import { isDirectConnectorSession } from './session-kind'

const TAG = 'session-consolidation'

const ALL_KNOWN_PEER_IDS_MIGRATION_FLAG = '_migration_allKnownPeerIds'
const THREAD_CONNECTOR_MIRROR_CLEANUP_FLAG = '_migration_pruneThreadConnectorMirrors'

export function backfillAllKnownPeerIds(): { migrated: number; skipped: boolean } {
  const settings = loadSettings() as Record<string, unknown>
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
    saveSession(session.id, session)
    migrated++
  }

  const updated = loadSettings() as Record<string, unknown>
  updated[ALL_KNOWN_PEER_IDS_MIGRATION_FLAG] = true
  saveSettings(updated)
  if (migrated > 0) {
    log.info(TAG, `Backfilled allKnownPeerIds on ${migrated} sessions`)
  }
  return { migrated, skipped: false }
}

export function pruneThreadConnectorMirrors(): { cleanedSessions: number; removedMessages: number; skipped: boolean } {
  const settings = loadSettings() as Record<string, unknown>
  if (settings[THREAD_CONNECTOR_MIRROR_CLEANUP_FLAG]) {
    return { cleanedSessions: 0, removedMessages: 0, skipped: true }
  }

  const sessions = loadSessions() as Record<string, Session>
  let cleanedSessions = 0
  let removedMessages = 0

  for (const session of Object.values(sessions)) {
    if (isDirectConnectorSession(session)) continue
    const msgCount = getMessageCount(session.id)
    if (msgCount === 0) continue

    const allMessages = getMessages(session.id)
    const filteredMessages = allMessages.filter((message) => !(
      message?.historyExcluded === true
      && typeof message?.source?.connectorId === 'string'
      && message.source.connectorId.trim().length > 0
    ))

    const removed = allMessages.length - filteredMessages.length
    if (removed <= 0) continue

    replaceAllMessages(session.id, filteredMessages)
    saveSession(session.id, session)
    cleanedSessions += 1
    removedMessages += removed
  }

  const updated = loadSettings() as Record<string, unknown>
  updated[THREAD_CONNECTOR_MIRROR_CLEANUP_FLAG] = true
  saveSettings(updated)
  if (removedMessages > 0) {
    log.info(TAG, `Pruned ${removedMessages} mirrored connector message(s) from ${cleanedSessions} main session(s)`)
  }
  return { cleanedSessions, removedMessages, skipped: false }
}
