import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { NetworkInfo, Directory, ProviderInfo, Credentials, Schedule, AppSettings, StoredSecret, ProviderConfig, Skill, Connector, Webhook, McpServerConfig, ExtensionMeta, Project, ActivityEntry, AppNotification, GatewayProfile } from '../../types'
import { api } from '@/lib/app/api-client'
import { safeStorageGetJson, safeStorageSet } from '@/lib/app/safe-storage'
import { fetchDirs, fetchProviders, fetchCredentials } from '@/lib/chat/chats'
import { fetchSchedules } from '@/lib/schedules/schedules'
import { setIfChanged, invalidateFingerprint } from '../set-if-changed'
import { createLoader } from '../store-utils'

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
  secrets: Record<string, StoredSecret>
  loadSecrets: () => Promise<void>
  providerConfigs: ProviderConfig[]
  loadProviderConfigs: () => Promise<void>
  gatewayProfiles: GatewayProfile[]
  loadGatewayProfiles: () => Promise<void>
  skills: Record<string, Skill>
  loadSkills: () => Promise<void>
  skillDraftCount: number
  loadSkillDraftCount: () => Promise<void>
  connectors: Record<string, Connector>
  loadConnectors: () => Promise<void>
  webhooks: Record<string, Webhook>
  loadWebhooks: () => Promise<void>
  mcpServers: Record<string, McpServerConfig>
  loadMcpServers: () => Promise<void>
  extensions: Record<string, ExtensionMeta>
  loadExtensions: () => Promise<void>
  projects: Record<string, Project>
  loadProjects: () => Promise<void>
  activityEntries: ActivityEntry[]
  loadActivity: (filters?: { entityType?: string; limit?: number }) => Promise<void>
  lastReadTimestamps: Record<string, number>
  markChatRead: (id: string) => void
  notifications: AppNotification[]
  unreadNotificationCount: number
  loadNotifications: () => Promise<void>
  markNotificationRead: (id: string) => Promise<void>
  markAllNotificationsRead: () => Promise<void>
  clearReadNotifications: () => Promise<void>
}

export const createDataSlice: StateCreator<AppState, [], [], DataSlice> = (set, get) => ({
  networkInfo: null,
  loadNetworkInfo: createLoader<AppState>(set, 'networkInfo', () => api<NetworkInfo>('GET', '/ip'), null),
  dirs: [],
  loadDirs: createLoader<AppState>(set, 'dirs', () => fetchDirs(), []),
  providers: [],
  credentials: {},
  loadProviders: createLoader<AppState>(set, 'providers', () => fetchProviders(), []),
  loadCredentials: createLoader<AppState>(set, 'credentials', () => fetchCredentials(), {}),
  schedules: {},
  loadSchedules: createLoader<AppState>(set, 'schedules', () => fetchSchedules(true), {}),
  appSettings: {},
  loadSettings: createLoader<AppState>(set, 'appSettings', () => api<AppSettings>('GET', '/settings'), {}),
  updateSettings: async (patch) => {
    try {
      const settings = await api<AppSettings>('PUT', '/settings', patch)
      invalidateFingerprint('appSettings')
      setIfChanged<AppState>(set, 'appSettings', settings)
    } catch (err: unknown) {
      console.warn('Store error:', err)
    }
  },
  secrets: {},
  loadSecrets: createLoader<AppState>(set, 'secrets', () => api<Record<string, StoredSecret>>('GET', '/secrets'), {}),
  providerConfigs: [],
  loadProviderConfigs: createLoader<AppState>(set, 'providerConfigs', () => api<ProviderConfig[]>('GET', '/providers/configs'), []),
  gatewayProfiles: [],
  loadGatewayProfiles: createLoader<AppState>(set, 'gatewayProfiles', () => api<GatewayProfile[]>('GET', '/gateways'), []),
  skills: {},
  loadSkills: createLoader<AppState>(set, 'skills', () => api<Record<string, Skill>>('GET', '/skills'), {}),
  skillDraftCount: 0,
  loadSkillDraftCount: async () => {
    try {
      const result = await api<{ total: number }>('GET', '/skill-review-counts')
      setIfChanged<AppState>(set, 'skillDraftCount', result.total)
    } catch (err: unknown) {
      console.warn('Store error:', err)
    }
  },
  connectors: {},
  loadConnectors: createLoader<AppState>(set, 'connectors', () => api<Record<string, Connector>>('GET', '/connectors'), {}),
  webhooks: {},
  loadWebhooks: createLoader<AppState>(set, 'webhooks', () => api<Record<string, Webhook>>('GET', '/webhooks'), {}),
  mcpServers: {},
  loadMcpServers: createLoader<AppState>(set, 'mcpServers', () => api<Record<string, McpServerConfig>>('GET', '/mcp-servers'), {}),
  // Manual: array→record transform
  extensions: {},
  loadExtensions: async () => {
    try {
      const list = await api<ExtensionMeta[]>('GET', '/extensions')
      const extensions: Record<string, ExtensionMeta> = {}
      for (const p of list) extensions[p.filename] = p
      setIfChanged<AppState>(set, 'extensions', extensions)
    } catch (err: unknown) {
      console.warn('Store error:', err)
      setIfChanged<AppState>(set, 'extensions', {})
    }
  },
  projects: {},
  loadProjects: createLoader<AppState>(set, 'projects', () => api<Record<string, Project>>('GET', '/projects'), {}),
  // Manual: params
  activityEntries: [],
  loadActivity: async (filters) => {
    try {
      const params = new URLSearchParams()
      if (filters?.entityType) params.set('entityType', filters.entityType)
      if (filters?.limit) params.set('limit', String(filters.limit))
      const qs = params.toString()
      const entries = await api<ActivityEntry[]>('GET', `/activity${qs ? `?${qs}` : ''}`)
      setIfChanged<AppState>(set, 'activityEntries', entries)
    } catch (err: unknown) {
      console.warn('Store error:', err)
      setIfChanged<AppState>(set, 'activityEntries', [])
    }
  },
  lastReadTimestamps: safeStorageGetJson<Record<string, number>>('sc_last_read', {}),
  markChatRead: (id) => {
    const ts = { ...get().lastReadTimestamps, [id]: Date.now() }
    set({ lastReadTimestamps: ts })
    safeStorageSet('sc_last_read', JSON.stringify(ts))
  },
  // Manual: derived state side-effect
  notifications: [],
  unreadNotificationCount: 0,
  loadNotifications: async () => {
    try {
      const notifications = await api<AppNotification[]>('GET', '/notifications')
      if (setIfChanged<AppState>(set, 'notifications', notifications)) {
        set({ unreadNotificationCount: notifications.filter((n) => !n.read).length })
      }
    } catch (err: unknown) {
      console.warn('Store error:', err)
      if (setIfChanged<AppState>(set, 'notifications', [])) {
        set({ unreadNotificationCount: 0 })
      }
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
    } catch (err: unknown) {
      console.warn('Store error:', err)
    }
  },
  markAllNotificationsRead: async () => {
    const unreadIds = get().notifications.filter((n) => !n.read).map((n) => n.id)
    if (!unreadIds.length) return
    const originalNotifications = get().notifications
    const notifications = originalNotifications.map((n) => ({ ...n, read: true }))
    set({ notifications, unreadNotificationCount: 0 })
    try {
      await Promise.all(unreadIds.map((id) => api('PUT', `/notifications/${id}`, { read: true })))
    } catch (err: unknown) {
      console.warn('Store error:', err)
      set({ notifications: originalNotifications, unreadNotificationCount: unreadIds.length })
    }
  },
  clearReadNotifications: async () => {
    const original = get().notifications
    const kept = original.filter((n) => !n.read)
    set({ notifications: kept, unreadNotificationCount: kept.length })
    try {
      await api('DELETE', '/notifications')
    } catch (err: unknown) {
      console.warn('Store error:', err)
      set({ notifications: original, unreadNotificationCount: original.filter((n) => !n.read).length })
    }
  }
})
