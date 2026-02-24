'use client'

import { create } from 'zustand'
import type { Sessions, Session, NetworkInfo, Directory, ProviderInfo, Credentials, Agent, Schedule, AppView, BoardTask, AppSettings, OrchestratorSecret, ProviderConfig, Skill, Connector, Webhook } from '../types'
import { fetchSessions, fetchDirs, fetchProviders, fetchCredentials } from '../lib/sessions'
import { fetchAgents } from '../lib/agents'
import { fetchSchedules } from '../lib/schedules'
import { fetchTasks } from '../lib/tasks'
import { api } from '../lib/api-client'

interface AppState {
  currentUser: string | null
  _hydrated: boolean
  hydrate: () => void
  setUser: (user: string | null) => void

  sessions: Sessions
  currentSessionId: string | null
  loadSessions: () => Promise<void>
  setCurrentSession: (id: string | null) => void
  removeSession: (id: string) => void
  clearSessions: (ids: string[]) => Promise<void>
  updateSessionInStore: (session: Session) => void

  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void

  networkInfo: NetworkInfo | null
  loadNetworkInfo: () => Promise<void>

  dirs: Directory[]
  loadDirs: () => Promise<void>

  providers: ProviderInfo[]
  credentials: Credentials
  loadProviders: () => Promise<void>
  loadCredentials: () => Promise<void>

  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  newSessionOpen: boolean
  setNewSessionOpen: (open: boolean) => void

  activeView: AppView
  setActiveView: (view: AppView) => void

  currentAgentId: string | null
  setCurrentAgent: (id: string | null) => Promise<void>

  agents: Record<string, Agent>
  loadAgents: () => Promise<void>

  schedules: Record<string, Schedule>
  loadSchedules: () => Promise<void>

  agentSheetOpen: boolean
  setAgentSheetOpen: (open: boolean) => void
  editingAgentId: string | null
  setEditingAgentId: (id: string | null) => void

  scheduleSheetOpen: boolean
  setScheduleSheetOpen: (open: boolean) => void
  editingScheduleId: string | null
  setEditingScheduleId: (id: string | null) => void

  memorySheetOpen: boolean
  setMemorySheetOpen: (open: boolean) => void
  selectedMemoryId: string | null
  setSelectedMemoryId: (id: string | null) => void
  memoryRefreshKey: number
  triggerMemoryRefresh: () => void
  memoryAgentFilter: string | null
  setMemoryAgentFilter: (agentId: string | null) => void

  appSettings: AppSettings
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>

  secrets: Record<string, OrchestratorSecret>
  loadSecrets: () => Promise<void>
  secretSheetOpen: boolean
  setSecretSheetOpen: (open: boolean) => void
  editingSecretId: string | null
  setEditingSecretId: (id: string | null) => void

  tasks: Record<string, BoardTask>
  loadTasks: (includeArchived?: boolean) => Promise<void>
  showArchivedTasks: boolean
  setShowArchivedTasks: (show: boolean) => void
  taskSheetOpen: boolean
  setTaskSheetOpen: (open: boolean) => void
  editingTaskId: string | null
  setEditingTaskId: (id: string | null) => void

  // Provider configs (custom providers)
  providerConfigs: ProviderConfig[]
  loadProviderConfigs: () => Promise<void>
  providerSheetOpen: boolean
  setProviderSheetOpen: (open: boolean) => void
  editingProviderId: string | null
  setEditingProviderId: (id: string | null) => void

  // Skills
  skills: Record<string, Skill>
  loadSkills: () => Promise<void>
  skillSheetOpen: boolean
  setSkillSheetOpen: (open: boolean) => void
  editingSkillId: string | null
  setEditingSkillId: (id: string | null) => void

  // Connectors
  connectors: Record<string, Connector>
  loadConnectors: () => Promise<void>
  connectorSheetOpen: boolean
  setConnectorSheetOpen: (open: boolean) => void
  editingConnectorId: string | null
  setEditingConnectorId: (id: string | null) => void

  // Webhooks
  webhooks: Record<string, Webhook>
  loadWebhooks: () => Promise<void>
  webhookSheetOpen: boolean
  setWebhookSheetOpen: (open: boolean) => void
  editingWebhookId: string | null
  setEditingWebhookId: (id: string | null) => void

}

export const useAppStore = create<AppState>((set, get) => ({
  currentUser: null,
  _hydrated: false,
  hydrate: () => {
    if (typeof window === 'undefined') return
    const user = localStorage.getItem('sc_user')
    set({ currentUser: user, _hydrated: true })
  },
  setUser: (user) => {
    if (user) localStorage.setItem('sc_user', user)
    else localStorage.removeItem('sc_user')
    set({ currentUser: user })
  },

  sessions: {},
  currentSessionId: null,
  loadSessions: async () => {
    try {
      const sessions = await fetchSessions()
      set({ sessions })
    } catch {
      // ignore
    }
  },
  setCurrentSession: (id) => set({ currentSessionId: id }),
  removeSession: (id) => {
    const sessions = { ...get().sessions }
    delete sessions[id]
    set({ sessions, currentSessionId: get().currentSessionId === id ? null : get().currentSessionId })
  },
  clearSessions: async (ids) => {
    if (!ids.length) return
    await api('DELETE', '/sessions', { ids })
    const sessions = { ...get().sessions }
    for (const id of ids) delete sessions[id]
    set({ sessions, currentSessionId: ids.includes(get().currentSessionId!) ? null : get().currentSessionId })
  },
  updateSessionInStore: (session) => {
    set({ sessions: { ...get().sessions, [session.id]: session } })
  },

  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  networkInfo: null,
  loadNetworkInfo: async () => {
    try {
      const info = await api<NetworkInfo>('GET', '/ip')
      set({ networkInfo: info })
    } catch {
      // ignore
    }
  },

  dirs: [],
  loadDirs: async () => {
    try {
      const dirs = await fetchDirs()
      set({ dirs })
    } catch {
      set({ dirs: [] })
    }
  },

  providers: [],
  credentials: {},
  loadProviders: async () => {
    try {
      const providers = await fetchProviders()
      set({ providers })
    } catch {
      // ignore
    }
  },
  loadCredentials: async () => {
    try {
      const credentials = await fetchCredentials()
      set({ credentials })
    } catch {
      // ignore
    }
  },

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  newSessionOpen: false,
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),

  activeView: 'agents',
  setActiveView: (view) => set({ activeView: view }),

  currentAgentId: null,
  setCurrentAgent: async (id) => {
    if (!id) {
      set({ currentAgentId: null })
      return
    }
    set({ currentAgentId: id })
    try {
      const user = get().currentUser || 'default'
      const session = await api<any>('POST', `/agents/${id}/thread`, { user })
      if (session?.id) {
        const sessions = { ...get().sessions, [session.id]: session }
        set({ sessions, currentSessionId: session.id })
      }
    } catch {
      // ignore — thread creation failed
    }
  },

  agents: {},
  loadAgents: async () => {
    try {
      const agents = await fetchAgents()
      set({ agents })
    } catch {
      // ignore
    }
  },

  schedules: {},
  loadSchedules: async () => {
    try {
      const schedules = await fetchSchedules()
      set({ schedules })
    } catch {
      // ignore
    }
  },

  agentSheetOpen: false,
  setAgentSheetOpen: (open) => set({ agentSheetOpen: open }),
  editingAgentId: null,
  setEditingAgentId: (id) => set({ editingAgentId: id }),

  scheduleSheetOpen: false,
  setScheduleSheetOpen: (open) => set({ scheduleSheetOpen: open }),
  editingScheduleId: null,
  setEditingScheduleId: (id) => set({ editingScheduleId: id }),

  memorySheetOpen: false,
  setMemorySheetOpen: (open) => set({ memorySheetOpen: open }),
  selectedMemoryId: null,
  setSelectedMemoryId: (id) => set({ selectedMemoryId: id }),
  memoryRefreshKey: 0,
  triggerMemoryRefresh: () => set((s) => ({ memoryRefreshKey: s.memoryRefreshKey + 1 })),
  memoryAgentFilter: null,
  setMemoryAgentFilter: (agentId) => set({ memoryAgentFilter: agentId }),

  appSettings: {},
  loadSettings: async () => {
    try {
      const settings = await api<AppSettings>('GET', '/settings')
      set({ appSettings: settings })
    } catch {
      // ignore
    }
  },
  updateSettings: async (patch) => {
    try {
      const settings = await api<AppSettings>('PUT', '/settings', patch)
      set({ appSettings: settings })
    } catch {
      // ignore
    }
  },

  secrets: {},
  loadSecrets: async () => {
    try {
      const secrets = await api<Record<string, OrchestratorSecret>>('GET', '/secrets')
      set({ secrets })
    } catch {
      // ignore
    }
  },
  secretSheetOpen: false,
  setSecretSheetOpen: (open) => set({ secretSheetOpen: open }),
  editingSecretId: null,
  setEditingSecretId: (id) => set({ editingSecretId: id }),

  tasks: {},
  loadTasks: async (includeArchived) => {
    try {
      const show = includeArchived ?? get().showArchivedTasks
      const tasks = await fetchTasks(show)
      set({ tasks })
    } catch {
      // ignore
    }
  },
  showArchivedTasks: false,
  setShowArchivedTasks: (show) => {
    set({ showArchivedTasks: show })
    get().loadTasks(show)
  },
  taskSheetOpen: false,
  setTaskSheetOpen: (open) => set({ taskSheetOpen: open }),
  editingTaskId: null,
  setEditingTaskId: (id) => set({ editingTaskId: id }),

  // Provider configs (custom providers)
  providerConfigs: [],
  loadProviderConfigs: async () => {
    try {
      const configs = await api<ProviderConfig[]>('GET', '/providers/configs')
      set({ providerConfigs: configs })
    } catch {
      // ignore
    }
  },
  providerSheetOpen: false,
  setProviderSheetOpen: (open) => set({ providerSheetOpen: open }),
  editingProviderId: null,
  setEditingProviderId: (id) => set({ editingProviderId: id }),

  // Skills
  skills: {},
  loadSkills: async () => {
    try {
      const skills = await api<Record<string, Skill>>('GET', '/skills')
      set({ skills })
    } catch {
      // ignore
    }
  },
  skillSheetOpen: false,
  setSkillSheetOpen: (open) => set({ skillSheetOpen: open }),
  editingSkillId: null,
  setEditingSkillId: (id) => set({ editingSkillId: id }),

  // Connectors
  connectors: {},
  loadConnectors: async () => {
    try {
      const connectors = await api<Record<string, Connector>>('GET', '/connectors')
      set({ connectors })
    } catch {
      // ignore
    }
  },
  connectorSheetOpen: false,
  setConnectorSheetOpen: (open) => set({ connectorSheetOpen: open }),
  editingConnectorId: null,
  setEditingConnectorId: (id) => set({ editingConnectorId: id }),

  // Webhooks
  webhooks: {},
  loadWebhooks: async () => {
    try {
      const webhooks = await api<Record<string, Webhook>>('GET', '/webhooks')
      set({ webhooks })
    } catch {
      // ignore
    }
  },
  webhookSheetOpen: false,
  setWebhookSheetOpen: (open) => set({ webhookSheetOpen: open }),
  editingWebhookId: null,
  setEditingWebhookId: (id) => set({ editingWebhookId: id }),

}))
