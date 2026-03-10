const inflightSessionRefreshes = new Map<string, Promise<void>>()
import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { Sessions, Session } from '../../types'
import { api } from '@/lib/app/api-client'
import { fetchChat, fetchChats } from '@/lib/chat/chats'
import { setIfChanged, invalidateFingerprint } from '../set-if-changed'

/** Derive the active session ID from the current agent — no stored `currentSessionId`. */
export function selectActiveSessionId(s: AppState): string | null {
  if (!s.currentAgentId) return null
  const agent = s.agents[s.currentAgentId]
  return agent?.threadSessionId ?? null
}

export interface SessionSlice {
  sessions: Sessions
  loadSessions: () => Promise<void>
  refreshSession: (id: string) => Promise<void>
  removeSession: (id: string) => void
  clearSessions: (ids: string[]) => Promise<void>
  togglePinSession: (id: string) => void
  updateSessionInStore: (session: Session) => void
}

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  sessions: {},
  loadSessions: async () => {
    try {
      const sessions = await fetchChats()
      setIfChanged<AppState>(set, 'sessions', sessions)
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
        invalidateFingerprint('sessions')
        set({
          sessions: { ...get().sessions, [id]: session },
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
  removeSession: (id) => {
    const sessions = { ...get().sessions }
    delete sessions[id]
    invalidateFingerprint('sessions')
    const activeSessionId = selectActiveSessionId(get())
    if (activeSessionId === id) {
      set({ sessions, currentAgentId: null })
    } else {
      set({ sessions })
    }
  },
  clearSessions: async (ids) => {
    if (!ids.length) return
    await api('DELETE', '/chats', { ids })
    const sessions = { ...get().sessions }
    for (const id of ids) delete sessions[id]
    invalidateFingerprint('sessions')
    const activeSessionId = selectActiveSessionId(get())
    if (activeSessionId && ids.includes(activeSessionId)) {
      set({ sessions, currentAgentId: null })
    } else {
      set({ sessions })
    }
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
  }
})
