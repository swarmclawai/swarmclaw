import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'

export interface AuthSlice {
  currentUser: string | null
  _hydrated: boolean
  hydrate: () => void
  setUser: (user: string | null) => void
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set, get) => ({
  currentUser: null,
  _hydrated: false,
  hydrate: () => {
    const user = safeStorageGet('sc_user')
    const savedAgentId = safeStorageGet('sc_agent')
    set({ currentUser: user, currentAgentId: savedAgentId, _hydrated: true })
  },
  setUser: (user) => {
    if (user) safeStorageSet('sc_user', user)
    else safeStorageRemove('sc_user')
    set({ currentUser: user })
  }
})
