import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { Sessions, Session } from '../../types'
import { api } from '@/lib/app/api-client'
import { fetchChat, fetchChats } from '@/lib/chat/chats'
import { invalidateFingerprint, setIfChanged } from '../set-if-changed'
import { createLoader, createInflightDeduplicator } from '../store-utils'

const sessionRefreshDedup = createInflightDeduplicator('sessionSlice_inflightRefreshes')

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
  togglePinSession: (id: string) => Promise<void>
  updateSessionInStore: (session: Session) => void
}

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set, get) => ({
  sessions: {},
  loadSessions: createLoader<AppState>(set, 'sessions', () => fetchChats()),
  refreshSession: async (id) => {
    if (!id) return
    await sessionRefreshDedup.dedup(id, async () => {
      try {
        const session = await fetchChat(id)
        const existing = get().sessions[id]
        // Skip update if the session data hasn't changed
        if (existing && JSON.stringify(existing) === JSON.stringify(session)) return
        invalidateFingerprint('sessions')
        set({
          sessions: { ...get().sessions, [id]: session },
        })
      } catch (err: unknown) {
        console.warn('Store error:', err)
      }
    })
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
  togglePinSession: async (id) => {
    const sessions = { ...get().sessions }
    if (!sessions[id]) return
    const wasPinned = sessions[id].pinned
    sessions[id] = { ...sessions[id], pinned: !wasPinned }
    invalidateFingerprint('sessions')
    set({ sessions })
    try {
      await api('PUT', `/chats/${id}`, { pinned: !wasPinned })
    } catch (err: unknown) {
      console.warn('Pin toggle failed:', err)
      await get().loadSessions()
    }
  },
  updateSessionInStore: (session) => {
    invalidateFingerprint('sessions')
    setIfChanged<AppState>(set, 'sessions', { ...get().sessions, [session.id]: session })
  }
})
