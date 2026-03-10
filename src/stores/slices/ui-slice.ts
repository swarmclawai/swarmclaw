import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { AppView, FleetFilter } from '../../types'
import { safeStorageGet, safeStorageSet } from '@/lib/app/safe-storage'

export interface UiSlice {
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  activeView: AppView
  setActiveView: (view: AppView) => void
  agentSheetOpen: boolean
  setAgentSheetOpen: (open: boolean) => void
  editingAgentId: string | null
  setEditingAgentId: (id: string | null) => void
  scheduleSheetOpen: boolean
  setScheduleSheetOpen: (open: boolean) => void
  editingScheduleId: string | null
  setEditingScheduleId: (id: string | null) => void
  scheduleTemplatePrefill: { name: string; taskPrompt: string; scheduleType: 'cron' | 'interval'; cron?: string; intervalMs?: number } | null
  setScheduleTemplatePrefill: (prefill: { name: string; taskPrompt: string; scheduleType: 'cron' | 'interval'; cron?: string; intervalMs?: number } | null) => void
  memorySheetOpen: boolean
  setMemorySheetOpen: (open: boolean) => void
  selectedMemoryId: string | null
  setSelectedMemoryId: (id: string | null) => void
  memoryRefreshKey: number
  triggerMemoryRefresh: () => void
  memoryAgentFilter: string | null
  setMemoryAgentFilter: (agentId: string | null) => void
  memoryTierFilter: 'all' | 'working' | 'durable' | 'archive'
  setMemoryTierFilter: (tier: 'all' | 'working' | 'durable' | 'archive') => void
  memoryScopeFilter: 'all' | 'global' | 'agent' | 'session' | 'project'
  setMemoryScopeFilter: (scope: 'all' | 'global' | 'agent' | 'session' | 'project') => void
  secretSheetOpen: boolean
  setSecretSheetOpen: (open: boolean) => void
  editingSecretId: string | null
  setEditingSecretId: (id: string | null) => void
  taskSheetOpen: boolean
  setTaskSheetOpen: (open: boolean) => void
  editingTaskId: string | null
  setEditingTaskId: (id: string | null) => void
  taskSheetViewOnly: boolean
  setTaskSheetViewOnly: (v: boolean) => void
  providerSheetOpen: boolean
  setProviderSheetOpen: (open: boolean) => void
  editingProviderId: string | null
  setEditingProviderId: (id: string | null) => void
  gatewaySheetOpen: boolean
  setGatewaySheetOpen: (open: boolean) => void
  editingGatewayId: string | null
  setEditingGatewayId: (id: string | null) => void
  skillSheetOpen: boolean
  setSkillSheetOpen: (open: boolean) => void
  editingSkillId: string | null
  setEditingSkillId: (id: string | null) => void
  connectorSheetOpen: boolean
  setConnectorSheetOpen: (open: boolean) => void
  editingConnectorId: string | null
  setEditingConnectorId: (id: string | null) => void
  webhookSheetOpen: boolean
  setWebhookSheetOpen: (open: boolean) => void
  editingWebhookId: string | null
  setEditingWebhookId: (id: string | null) => void
  mcpServerSheetOpen: boolean
  setMcpServerSheetOpen: (open: boolean) => void
  editingMcpServerId: string | null
  setEditingMcpServerId: (id: string | null) => void
  knowledgeSheetOpen: boolean
  setKnowledgeSheetOpen: (open: boolean) => void
  editingKnowledgeId: string | null
  setEditingKnowledgeId: (id: string | null) => void
  knowledgeRefreshKey: number
  triggerKnowledgeRefresh: () => void
  pluginSheetOpen: boolean
  setPluginSheetOpen: (open: boolean) => void
  editingPluginFilename: string | null
  setEditingPluginFilename: (filename: string | null) => void
  projectSheetOpen: boolean
  setProjectSheetOpen: (open: boolean) => void
  editingProjectId: string | null
  setEditingProjectId: (id: string | null) => void
  activeProjectFilter: string | null
  setActiveProjectFilter: (id: string | null) => void
  showTrash: boolean
  setShowTrash: (show: boolean) => void
  inspectorOpen: boolean
  setInspectorOpen: (open: boolean) => void
  inspectorTab: 'overview' | 'files' | 'skills' | 'automations' | 'advanced'
  setInspectorTab: (tab: 'overview' | 'files' | 'skills' | 'automations' | 'advanced') => void
  fleetFilter: FleetFilter
  setFleetFilter: (filter: FleetFilter) => void
  chatFilter: 'all' | 'active' | 'recent'
  setChatFilter: (filter: 'all' | 'active' | 'recent') => void
  walletPanelAgentId: string | null
  setWalletPanelAgentId: (id: string | null) => void
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set, get) => ({
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  activeView: 'home',
  setActiveView: (view) => set({ activeView: view }),
  agentSheetOpen: false,
  setAgentSheetOpen: (open) => set({ agentSheetOpen: open }),
  editingAgentId: null,
  setEditingAgentId: (id) => set({ editingAgentId: id }),
  scheduleSheetOpen: false,
  setScheduleSheetOpen: (open) => set({ scheduleSheetOpen: open }),
  editingScheduleId: null,
  setEditingScheduleId: (id) => set({ editingScheduleId: id }),
  scheduleTemplatePrefill: null,
  setScheduleTemplatePrefill: (prefill) => set({ scheduleTemplatePrefill: prefill }),
  memorySheetOpen: false,
  setMemorySheetOpen: (open) => set({ memorySheetOpen: open }),
  selectedMemoryId: null,
  setSelectedMemoryId: (id) => set({ selectedMemoryId: id }),
  memoryRefreshKey: 0,
  triggerMemoryRefresh: () => set((s) => ({ memoryRefreshKey: s.memoryRefreshKey + 1 })),
  memoryAgentFilter: null,
  setMemoryAgentFilter: (agentId) => set({ memoryAgentFilter: agentId }),
  memoryTierFilter: 'all',
  setMemoryTierFilter: (tier) => set({ memoryTierFilter: tier }),
  memoryScopeFilter: 'all',
  setMemoryScopeFilter: (scope) => set({ memoryScopeFilter: scope }),
  secretSheetOpen: false,
  setSecretSheetOpen: (open) => set({ secretSheetOpen: open }),
  editingSecretId: null,
  setEditingSecretId: (id) => set({ editingSecretId: id }),
  taskSheetOpen: false,
  setTaskSheetOpen: (open) => set({ taskSheetOpen: open, ...(open ? {} : { taskSheetViewOnly: false }) }),
  editingTaskId: null,
  setEditingTaskId: (id) => set({ editingTaskId: id }),
  taskSheetViewOnly: false,
  setTaskSheetViewOnly: (v) => set({ taskSheetViewOnly: v }),
  providerSheetOpen: false,
  setProviderSheetOpen: (open) => set({ providerSheetOpen: open }),
  editingProviderId: null,
  setEditingProviderId: (id) => set({ editingProviderId: id }),
  gatewaySheetOpen: false,
  setGatewaySheetOpen: (open) => set({ gatewaySheetOpen: open }),
  editingGatewayId: null,
  setEditingGatewayId: (id) => set({ editingGatewayId: id }),
  skillSheetOpen: false,
  setSkillSheetOpen: (open) => set({ skillSheetOpen: open }),
  editingSkillId: null,
  setEditingSkillId: (id) => set({ editingSkillId: id }),
  connectorSheetOpen: false,
  setConnectorSheetOpen: (open) => set({ connectorSheetOpen: open }),
  editingConnectorId: null,
  setEditingConnectorId: (id) => set({ editingConnectorId: id }),
  webhookSheetOpen: false,
  setWebhookSheetOpen: (open) => set({ webhookSheetOpen: open }),
  editingWebhookId: null,
  setEditingWebhookId: (id) => set({ editingWebhookId: id }),
  mcpServerSheetOpen: false,
  setMcpServerSheetOpen: (open) => set({ mcpServerSheetOpen: open }),
  editingMcpServerId: null,
  setEditingMcpServerId: (id) => set({ editingMcpServerId: id }),
  knowledgeSheetOpen: false,
  setKnowledgeSheetOpen: (open) => set({ knowledgeSheetOpen: open }),
  editingKnowledgeId: null,
  setEditingKnowledgeId: (id) => set({ editingKnowledgeId: id }),
  knowledgeRefreshKey: 0,
  triggerKnowledgeRefresh: () => set((s) => ({ knowledgeRefreshKey: s.knowledgeRefreshKey + 1 })),
  pluginSheetOpen: false,
  setPluginSheetOpen: (open) => set({ pluginSheetOpen: open }),
  editingPluginFilename: null,
  setEditingPluginFilename: (filename) => set({ editingPluginFilename: filename }),
  projectSheetOpen: false,
  setProjectSheetOpen: (open) => set({ projectSheetOpen: open }),
  editingProjectId: null,
  setEditingProjectId: (id) => set({ editingProjectId: id }),
  activeProjectFilter: null,
  setActiveProjectFilter: (id) => set({ activeProjectFilter: id }),
  showTrash: false,
  setShowTrash: (show) => set({ showTrash: show }),
  inspectorOpen: false,
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  inspectorTab: 'overview',
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  fleetFilter: (safeStorageGet('sc_fleet_filter') as FleetFilter) || 'all',
  setFleetFilter: (filter) => { safeStorageSet('sc_fleet_filter', filter); set({ fleetFilter: filter }) },
  chatFilter: 'all' as const,
  setChatFilter: (filter) => set({ chatFilter: filter }),
  walletPanelAgentId: null,
  setWalletPanelAgentId: (id) => set({ walletPanelAgentId: id })
})
