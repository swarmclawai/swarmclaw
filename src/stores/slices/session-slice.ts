const inflightSessionRefreshes = new Map<string, Promise<void>>()
import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { Sessions, Session } from '../../types'
import { fetchChat, fetchChats } from '../../lib/chats'
import { api } from '../../lib/api-client'
import { errorMessage } from '../../lib/shared-utils'
import { setIfChanged, invalidateFingerprint } from '../set-if-changed'

export interface SessionSlice {
  sessions: Sessions
  currentSessionId: string | null
  loadSessions: () => Promise<void>
  refreshSession: (id: string) => Promise<void>
  setCurrentSession: (id: string | null) => void
  removeSession: (id: string) => void
  clearSessions: (ids: string[]) => Promise<void>
  togglePinSession: (id: string) => void
  updateSessionInStore: (session: Session) => void
  forkSession: (sessionId: string, messageIndex: number) => Promise<string | null>
}

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  sessions: {},
  currentSessionId: null,
  loadSessions: async () => {
    try {
      const sessions = await fetchChats()
      const changed = setIfChanged<AppState>(set, 'sessions', sessions)
      if (changed) {
        const currentSessionId = get().currentSessionId
        if (currentSessionId && !sessions[currentSessionId]) {
          set({ currentSessionId: null })
        }
      }
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  refreshSession: async (id) => {
    if (!id) return
    const existing = inflightSessionRefreshes.get(id)
    if (existing) {
      await existing
      return
    }

    const refreshPromise = (async () => {
      try {
        const session = await fetchChat(id)
        const currentSessionId = get().currentSessionId
        invalidateFingerprint('sessions')
        set({
          sessions: { ...get().sessions, [id]: session },
          currentSessionId: currentSessionId && currentSessionId === id ? id : currentSessionId,
        })
      } catch (err) {
      console.warn('Store error:', err)
    }
    })()

    inflightSessionRefreshes.set(id, refreshPromise)
    try {
      await refreshPromise
    } finally {
      if (inflightSessionRefreshes.get(id) === refreshPromise) {
        inflightSessionRefreshes.delete(id)
      }
    }
  },
  setCurrentSession: (id) => set({ currentSessionId: id }),
  removeSession: (id) => {
    const sessions = { ...get().sessions }
    delete sessions[id]
    invalidateFingerprint('sessions')
    set({ sessions, currentSessionId: get().currentSessionId === id ? null : get().currentSessionId })
  },
  clearSessions: async (ids) => {
    if (!ids.length) return
    await api('DELETE', '/chats', { ids })
    const sessions = { ...get().sessions }
    for (const id of ids) delete sessions[id]
    invalidateFingerprint('sessions')
    set({ sessions, currentSessionId: ids.includes(get().currentSessionId!) ? null : get().currentSessionId })
  },
  togglePinSession: (id) => {
    const sessions = { ...get().sessions }
    if (sessions[id]) {
      sessions[id] = { ...sessions[id], pinned: !sessions[id].pinned }
      invalidateFingerprint('sessions')
      set({ sessions })
      // Persist to server
      void api('PUT', `/chats/${id}`, { pinned: sessions[id].pinned })
    }
  },
  updateSessionInStore: (session) => {
    invalidateFingerprint('sessions')
    set({ sessions: { ...get().sessions, [session.id]: session } })
  },
  forkSession: async (sessionId, messageIndex) => {
    try {
      const forked = await api<Session>('POST', `/chats/${sessionId}/fork`, { messageIndex })
      if (!forked?.id) return null
      await get().loadSessions()
      set({ currentSessionId: forked.id })
      return forked.id
    } catch (err: unknown) {
      console.error('Fork failed:', errorMessage(err))
      return null
    }
  }
})
