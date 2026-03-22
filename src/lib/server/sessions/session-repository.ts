import type { Message, Session } from '@/types'

import {
  deleteSession as deleteStoredSession,
  disableAllSessionHeartbeats as disableAllStoredSessionHeartbeats,
  loadSession as loadStoredSession,
  loadSessions as loadStoredSessions,
  patchSession as patchStoredSession,
  saveSessions as replaceStoredSessions,
  upsertSession as upsertStoredSession,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'
import { getMessages } from '@/lib/server/messages/message-repository'

export const sessionRepository = createRecordRepository<Session>(
  'sessions',
  {
    get(id) {
      return loadStoredSession(id) as Session | null
    },
    list() {
      return loadStoredSessions() as Record<string, Session>
    },
    upsert(id, value) {
      upsertStoredSession(id, value as Session)
    },
    upsertMany(entries) {
      replaceStoredSessions(Object.fromEntries(entries))
    },
    replace(data) {
      replaceStoredSessions(data)
    },
    patch(id, updater) {
      return patchStoredSession(id, updater as (current: Session | null) => Session | null) as Session | null
    },
    delete(id) {
      deleteStoredSession(id)
    },
  },
)

export function listSessions(): Record<string, Session> {
  return sessionRepository.list()
}

export function getSession(id: string): Session | null {
  return sessionRepository.get(id)
}

export function getSessions(ids: string[]): Record<string, Session> {
  return sessionRepository.getMany(ids)
}

export function saveSession(id: string, session: Session | Record<string, unknown>): void {
  sessionRepository.upsert(id, session as Session)
}

export function saveSessionMany(entries: Array<[string, Session | Record<string, unknown>]>): void {
  sessionRepository.upsertMany(entries as Array<[string, Session]>)
}

export function replaceSessions(sessions: Record<string, Session | Record<string, unknown>>): void {
  sessionRepository.replace(sessions as Record<string, Session>)
}

export function patchSession(id: string, updater: (current: Session | null) => Session | null): Session | null {
  return sessionRepository.patch(id, updater)
}

export function deleteSession(id: string): void {
  sessionRepository.delete(id)
}

export function getSessionMessages(sessionId: string): Message[] {
  return getMessages(sessionId)
}

export function disableAllSessionHeartbeats(): number {
  return disableAllStoredSessionHeartbeats()
}

export const loadSessions = listSessions
export const loadSession = getSession
export const saveSessions = replaceSessions
export const upsertSession = saveSession
