const inflightAgentThreadLoads = new Map<string, Promise<void>>()
import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { Session, Agent, ExternalAgentRuntime } from '../../types'
import { fetchAgents } from '../../lib/agents'
import { api } from '@/lib/app/api-client'
import { safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'
import { setIfChanged, invalidateFingerprint } from '../set-if-changed'

export interface AgentSlice {
  currentAgentId: string | null
  setCurrentAgent: (id: string | null) => Promise<void>
  agents: Record<string, Agent>
  loadAgents: () => Promise<void>
  updateAgentInStore: (agent: Agent) => void
  togglePinAgent: (id: string) => void
  trashedAgents: Record<string, Agent>
  loadTrashedAgents: () => Promise<void>
  externalAgents: ExternalAgentRuntime[]
  loadExternalAgents: () => Promise<void>
}

export const createAgentSlice: StateCreator<AppState, [], [], AgentSlice> = (set, get) => ({
  currentAgentId: null,
  setCurrentAgent: async (id) => {
    if (!id) {
      set({ currentAgentId: null })
      safeStorageRemove('sc_agent')
      return
    }
    if (get().currentAgentId === id && get().agents[id]?.threadSessionId) {
      return
    }
    set({ currentAgentId: id })
    safeStorageSet('sc_agent', id)

    const existingLoad = inflightAgentThreadLoads.get(id)
    if (existingLoad) {
      await existingLoad
      return
    }

    const loadPromise = (async () => {
      try {
        const user = get().currentUser || 'default'
        const session = await api<Session>('POST', `/agents/${id}/thread`, { user })
        if (session?.id) {
          const agents = { ...get().agents }
          if (agents[id]) {
            agents[id] = { ...agents[id], threadSessionId: session.id }
          }
          const sessions = { ...get().sessions, [session.id]: session }
          invalidateFingerprint('sessions')
          set({ sessions, agents })
        }
      } catch {
        // ignore — thread creation failed
      }
    })()

    inflightAgentThreadLoads.set(id, loadPromise)
    try {
      await loadPromise
    } finally {
      if (inflightAgentThreadLoads.get(id) === loadPromise) {
        inflightAgentThreadLoads.delete(id)
      }
    }
  },
  agents: {},
  loadAgents: async () => {
    try {
      const agents = await fetchAgents()
      setIfChanged<AppState>(set, 'agents', agents)
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  updateAgentInStore: (agent) => {
    invalidateFingerprint('agents')
    set({ agents: { ...get().agents, [agent.id]: agent } })
  },
  togglePinAgent: (id) => {
    const agents = { ...get().agents }
    if (agents[id]) {
      agents[id] = { ...agents[id], pinned: !agents[id].pinned }
      invalidateFingerprint('agents')
      set({ agents })
      void api('PUT', `/agents/${id}`, { pinned: agents[id].pinned })
    }
  },
  trashedAgents: {},
  loadTrashedAgents: async () => {
    try {
      const trashedAgents = await api<Record<string, Agent>>('GET', '/agents/trash')
      setIfChanged<AppState>(set, 'trashedAgents', trashedAgents)
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  externalAgents: [],
  loadExternalAgents: async () => {
    try {
      const externalAgents = await api<ExternalAgentRuntime[]>('GET', '/external-agents')
      setIfChanged<AppState>(set, 'externalAgents', externalAgents)
    } catch (err) {
      console.warn('Store error:', err)
    }
  }
})
