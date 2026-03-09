import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { NetworkInfo, Directory, ProviderInfo, Credentials, Schedule, AppSettings, OrchestratorSecret, ProviderConfig, Skill, Connector, Webhook, McpServerConfig, PluginMeta, Project, ActivityEntry, AppNotification, ApprovalRequest, GatewayProfile } from '../../types'
import { fetchDirs, fetchProviders, fetchCredentials } from '../../lib/chats'
import { fetchSchedules } from '../../lib/schedules'
import { api } from '../../lib/api-client'
import { safeStorageGetJson, safeStorageSet } from '../../lib/safe-storage'

export interface DataSlice {
  networkInfo: NetworkInfo | null
  loadNetworkInfo: () => Promise<void>
  dirs: Directory[]
  loadDirs: () => Promise<void>
  providers: ProviderInfo[]
  credentials: Credentials
  loadProviders: () => Promise<void>
  loadCredentials: () => Promise<void>
  schedules: Record<string, Schedule>
  loadSchedules: () => Promise<void>
  appSettings: AppSettings
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  secrets: Record<string, OrchestratorSecret>
  loadSecrets: () => Promise<void>
  providerConfigs: ProviderConfig[]
  loadProviderConfigs: () => Promise<void>
  gatewayProfiles: GatewayProfile[]
  loadGatewayProfiles: () => Promise<void>
  skills: Record<string, Skill>
  loadSkills: () => Promise<void>
  connectors: Record<string, Connector>
  loadConnectors: () => Promise<void>
  webhooks: Record<string, Webhook>
  loadWebhooks: () => Promise<void>
  mcpServers: Record<string, McpServerConfig>
  loadMcpServers: () => Promise<void>
  plugins: Record<string, PluginMeta>
  loadPlugins: () => Promise<void>
  projects: Record<string, Project>
  loadProjects: () => Promise<void>
  activityEntries: ActivityEntry[]
  loadActivity: (filters?: { entityType?: string; limit?: number }) => Promise<void>
  lastReadTimestamps: Record<string, number>
  markChatRead: (id: string) => void
  approvals: Record<string, ApprovalRequest>
  loadApprovals: () => Promise<void>
  submitApprovalDecision: (id: string, approved: boolean) => Promise<void>
  notifications: AppNotification[]
  unreadNotificationCount: number
  loadNotifications: () => Promise<void>
  markNotificationRead: (id: string) => Promise<void>
  markAllNotificationsRead: () => Promise<void>
  clearReadNotifications: () => Promise<void>
}

export const createDataSlice: StateCreator<AppState, [], [], DataSlice> = (set, get) => ({
  networkInfo: null,
  loadNetworkInfo: async () => {
    try {
      const info = await api<NetworkInfo>('GET', '/ip')
      set({ networkInfo: info })
    } catch (err) {
      console.warn('Store error:', err)
      set({ networkInfo: null })
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
    } catch (err) {
      console.warn('Store error:', err)
      set({ providers: [] })
    }
  },
  loadCredentials: async () => {
    try {
      const credentials = await fetchCredentials()
      set({ credentials })
    } catch (err) {
      console.warn('Store error:', err)
      set({ credentials: {} })
    }
  },
  schedules: {},
  loadSchedules: async () => {
    try {
      const schedules = await fetchSchedules()
      set({ schedules })
    } catch (err) {
      console.warn('Store error:', err)
      set({ schedules: {} })
    }
  },
  appSettings: {},
  loadSettings: async () => {
    try {
      const settings = await api<AppSettings>('GET', '/settings')
      set({ appSettings: settings })
    } catch (err) {
      console.warn('Store error:', err)
      set({ appSettings: {} })
    }
  },
  updateSettings: async (patch) => {
    try {
      const settings = await api<AppSettings>('PUT', '/settings', patch)
      set({ appSettings: settings })
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  secrets: {},
  loadSecrets: async () => {
    try {
      const secrets = await api<Record<string, OrchestratorSecret>>('GET', '/secrets')
      set({ secrets })
    } catch (err) {
      console.warn('Store error:', err)
      set({ secrets: {} })
    }
  },
  providerConfigs: [],
  loadProviderConfigs: async () => {
    try {
      const configs = await api<ProviderConfig[]>('GET', '/providers/configs')
      set({ providerConfigs: configs })
    } catch (err) {
      console.warn('Store error:', err)
      set({ providerConfigs: [] })
    }
  },
  gatewayProfiles: [],
  loadGatewayProfiles: async () => {
    try {
      const gatewayProfiles = await api<GatewayProfile[]>('GET', '/gateways')
      set({ gatewayProfiles })
    } catch (err) {
      console.warn('Store error:', err)
      set({ gatewayProfiles: [] })
    }
  },
  skills: {},
  loadSkills: async () => {
    try {
      const skills = await api<Record<string, Skill>>('GET', '/skills')
      set({ skills })
    } catch (err) {
      console.warn('Store error:', err)
      set({ skills: {} })
    }
  },
  connectors: {},
  loadConnectors: async () => {
    try {
      const connectors = await api<Record<string, Connector>>('GET', '/connectors')
      set({ connectors })
    } catch (err) {
      console.warn('Store error:', err)
      set({ connectors: {} })
    }
  },
  webhooks: {},
  loadWebhooks: async () => {
    try {
      const webhooks = await api<Record<string, Webhook>>('GET', '/webhooks')
      set({ webhooks })
    } catch (err) {
      console.warn('Store error:', err)
      set({ webhooks: {} })
    }
  },
  mcpServers: {},
  loadMcpServers: async () => {
    try {
      const mcpServers = await api<Record<string, McpServerConfig>>('GET', '/mcp-servers')
      set({ mcpServers })
    } catch (err) {
      console.warn('Store error:', err)
      set({ mcpServers: {} })
    }
  },
  plugins: {},
  loadPlugins: async () => {
    try {
      const list = await api<PluginMeta[]>('GET', '/plugins')
      const plugins: Record<string, PluginMeta> = {}
      for (const p of list) plugins[p.filename] = p
      set({ plugins })
    } catch (err) {
      console.warn('Store error:', err)
      set({ plugins: {} })
    }
  },
  projects: {},
  loadProjects: async () => {
    try {
      const projects = await api<Record<string, Project>>('GET', '/projects')
      set({ projects })
    } catch (err) {
      console.warn('Store error:', err)
      set({ projects: {} })
    }
  },
  activityEntries: [],
  loadActivity: async (filters) => {
    try {
      const params = new URLSearchParams()
      if (filters?.entityType) params.set('entityType', filters.entityType)
      if (filters?.limit) params.set('limit', String(filters.limit))
      const qs = params.toString()
      const entries = await api<ActivityEntry[]>('GET', `/activity${qs ? `?${qs}` : ''}`)
      set({ activityEntries: entries })
    } catch (err) {
      console.warn('Store error:', err)
      set({ activityEntries: [] })
    }
  },
  lastReadTimestamps: safeStorageGetJson<Record<string, number>>('sc_last_read', {}),
  markChatRead: (id) => {
    const ts = { ...get().lastReadTimestamps, [id]: Date.now() }
    set({ lastReadTimestamps: ts })
    safeStorageSet('sc_last_read', JSON.stringify(ts))
  },
  approvals: {},
  loadApprovals: async () => {
    try {
      const list = await api<ApprovalRequest[]>('GET', '/approvals')
      const approvals: Record<string, ApprovalRequest> = {}
      for (const a of list) approvals[a.id] = a
      set({ approvals })
    } catch (err) { console.warn('Store error:', err) }
  },
  submitApprovalDecision: async (id, approved) => {
    try {
      await api('POST', '/approvals', { id, approved })
      await get().loadApprovals()
    } catch (err) { console.warn('Store error:', err) }
  },
  notifications: [],
  unreadNotificationCount: 0,
  loadNotifications: async () => {
    try {
      const notifications = await api<AppNotification[]>('GET', '/notifications')
      set({
        notifications,
        unreadNotificationCount: notifications.filter((n) => !n.read).length,
      })
    } catch (err) {
      console.warn('Store error:', err)
      set({ notifications: [], unreadNotificationCount: 0 })
    }
  },
  markNotificationRead: async (id) => {
    const notifications = get().notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    )
    set({
      notifications,
      unreadNotificationCount: notifications.filter((n) => !n.read).length,
    })
    try {
      await api('PUT', `/notifications/${id}`, { read: true })
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  markAllNotificationsRead: async () => {
    const notifications = get().notifications.map((n) => ({ ...n, read: true }))
    set({ notifications, unreadNotificationCount: 0 })
    try {
      await Promise.all(
        get().notifications.filter((n) => !n.read).map((n) => api('PUT', `/notifications/${n.id}`, { read: true })),
      )
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  clearReadNotifications: async () => {
    const notifications = get().notifications.filter((n) => !n.read)
    set({ notifications, unreadNotificationCount: notifications.length })
    try {
      await api('DELETE', '/notifications')
    } catch (err) {
      console.warn('Store error:', err)
    }
  }
})
