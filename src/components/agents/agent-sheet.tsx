'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { createAgent, updateAgent, deleteAgent } from '@/lib/agents'
import { api } from '@/lib/app/api-client'
import { fetchProviderModelDiscovery } from '@/lib/provider-model-discovery-client'
import { sleep } from '@/lib/shared-utils'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { toast } from 'sonner'
import { ModelCombobox } from '@/components/shared/model-combobox'
import type { ProviderType, ClaudeSkill, AgentWallet, AgentPackManifest, AgentRoutingStrategy, AgentRoutingTarget } from '@/types'
import { WalletSection } from '@/components/wallets/wallet-section'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS } from '@/lib/tool-definitions'
import { NATIVE_CAPABILITY_PROVIDER_IDS, NON_LANGGRAPH_PROVIDER_IDS, WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { isOrchestratorProviderEligible } from '@/lib/orchestrator-config'
import { AgentAvatar } from './agent-avatar'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { randomSoul } from '@/lib/soul-suggestions'
import { copyTextToClipboard } from '@/lib/clipboard'
import { SectionLabel } from '@/components/shared/section-label'
import { AdvancedSettingsSection } from '@/components/shared/advanced-settings-section'
import { SoulLibraryPicker } from './soul-library-picker'
import { HintTip } from '@/components/shared/hint-tip'
import { StatusDot } from '@/components/ui/status-dot'
import { resolveStoredOllamaMode } from '@/lib/ollama-mode'
import { errorMessage } from '@/lib/shared-utils'
import { getDefaultAgentToolIds } from '@/lib/agent-default-tools'
import { getEnabledExtensionIds, getEnabledToolIds } from '@/lib/capability-selection'
import { buildAgentSelectableProviders, resolveAgentSelectableProviderCredentials } from '@/lib/agent-provider-options'

const HB_PRESETS = [1800, 3600, 7200, 21600, 43200] as const
const FALLBACK_ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
const AUTO_SYNC_MODEL_PROVIDER_IDS = new Set<ProviderType>([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'together',
  'mistral',
  'xai',
  'fireworks',
  'nebius',
  'deepinfra',
  'ollama',
])
const CONNECTION_TEST_TIMEOUT_MS = 40_000
type AgentProviderId = string

type SafeAgentWallet = Omit<AgentWallet, 'encryptedPrivateKey'> & {
  balanceAtomic?: string
  balanceLamports?: number
  balanceFormatted?: string
  balanceSymbol?: string
  isActive?: boolean
}

function SectionCard({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`mb-8 rounded-[20px] border border-white/[0.06] bg-surface/70 p-5 sm:p-6 ${className}`}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-[17px] font-700 tracking-[-0.02em] text-text">{title}</h3>
          {description && (
            <p className="mt-1 text-[13px] leading-[1.6] text-text-3/75">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function formatHbDuration(sec: number): string {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m`
  return `${sec}s`
}

/** Parse a stored heartbeatInterval string or heartbeatIntervalSec number to a select-friendly string of seconds */
function parseDurationToSec(interval: string | number | null | undefined, intervalSec: number | null | undefined): string {
  if (intervalSec != null && Number.isFinite(intervalSec) && intervalSec > 0) {
    // Snap to nearest preset if close, otherwise use raw value
    const closest = HB_PRESETS.find((p) => p === Math.round(intervalSec))
    if (closest) return String(closest)
  }
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    return String(Math.round(interval))
  }
  if (interval != null && typeof interval === 'string' && interval.trim()) {
    const t = interval.trim().toLowerCase()
    const n = Number(t)
    if (Number.isFinite(n) && n > 0) return String(Math.round(n))
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/)
    if (m && (m[1] || m[2] || m[3])) {
      const total = (m[1] ? parseInt(m[1]) * 3600 : 0) + (m[2] ? parseInt(m[2]) * 60 : 0) + (m[3] ? parseInt(m[3]) : 0)
      if (total > 0) return String(total)
    }
  }
  return '' // default
}

function formatIdentityList(value: string[] | null | undefined): string {
  return Array.isArray(value) ? value.join('\n') : ''
}

function parseIdentityList(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false
      const key = line.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function formatGatewayTagList(value: string[] | null | undefined): string {
  return Array.isArray(value) ? value.join(', ') : ''
}

function parseGatewayTagList(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false
      const key = entry.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function AgentSheet() {
  const open = useAppStore((s) => s.agentSheetOpen)
  const setOpen = useAppStore((s) => s.setAgentSheetOpen)
  const editingId = useAppStore((s) => s.editingAgentId)
  const setEditingId = useAppStore((s) => s.setEditingAgentId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const updateAgentInStore = useAppStore((s) => s.updateAgentInStore)
  const activeSessionId = useAppStore(selectActiveSessionId)
  const currentSession = useAppStore((s) => {
    const id = selectActiveSessionId(s)
    return id ? s.sessions[id] : null
  })
  const refreshSession = useAppStore((s) => s.refreshSession)
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const gatewayProfiles = useAppStore((s) => s.gatewayProfiles)
  const loadGatewayProfiles = useAppStore((s) => s.loadGatewayProfiles)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const dynamicSkills = useAppStore((s) => s.skills)
  const mcpServers = useAppStore((s) => s.mcpServers)
  const loadSkills = useAppStore((s) => s.loadSkills)
  const [claudeSkills, setClaudeSkills] = useState<ClaudeSkill[]>([])
  const [claudeSkillsLoading, setClaudeSkillsLoading] = useState(false)
  const loadClaudeSkills = async () => {
    setClaudeSkillsLoading(true)
    try {
      const skills = await api<ClaudeSkill[]>('GET', '/claude-skills')
      setClaudeSkills(skills)
    } catch { /* ignore */ }
    finally { setClaudeSkillsLoading(false) }
  }

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [soul, setSoul] = useState('')
  const [soulInitial, setSoulInitial] = useState('')
  const [soulSaveState, setSoulSaveState] = useState<'idle' | 'saved'>('idle')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [provider, setProvider] = useState<AgentProviderId>('claude-cli')
  const [model, setModel] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [apiEndpoint, setApiEndpoint] = useState<string | null>(null)
  const [gatewayProfileId, setGatewayProfileId] = useState<string | null>(null)
  const [preferredGatewayTagsText, setPreferredGatewayTagsText] = useState('')
  const [preferredGatewayUseCase, setPreferredGatewayUseCase] = useState('')
  const [routingStrategy, setRoutingStrategy] = useState<AgentRoutingStrategy>('single')
  const [routingTargets, setRoutingTargets] = useState<AgentRoutingTarget[]>([])
  const [role, setRole] = useState<'worker' | 'coordinator'>('worker')
  const [delegationEnabled, setDelegationEnabled] = useState(false)
  const [delegationTargetMode, setDelegationTargetMode] = useState<'all' | 'selected'>('all')
  const [delegationTargetAgentIds, setDelegationTargetAgentIds] = useState<string[]>([])
  const [tools, setTools] = useState<string[]>([])
  const [extensions, setExtensions] = useState<string[]>([])
  const [enabledExtensionIds, setEnabledExtensionIds] = useState<Set<string> | null>(null)
  const [skills, setSkills] = useState<string[]>([])
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([])
  const [mcpDisabledTools, setMcpDisabledTools] = useState<string[]>([])
  const [mcpTools, setMcpTools] = useState<Record<string, { name: string; description: string }[]>>({})
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false)
  const [fallbackCredentialIds, setFallbackCredentialIds] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [capInput, setCapInput] = useState('')
  const [ollamaMode, setOllamaMode] = useState<'local' | 'cloud'>('local')
  const [openclawEnabled, setOpenclawEnabled] = useState(false)
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [avatarSeed, setAvatarSeed] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [thinkingLevel, setThinkingLevel] = useState<'' | 'minimal' | 'low' | 'medium' | 'high'>('')
  const [memoryScopeMode, setMemoryScopeMode] = useState<'auto' | 'all' | 'global' | 'agent' | 'session' | 'project'>('auto')
  const [memoryTierPreference, setMemoryTierPreference] = useState<'working' | 'durable' | 'archive' | 'blended'>('blended')
  const [proactiveMemory, setProactiveMemory] = useState(true)
  const [autoDraftSkillSuggestions, setAutoDraftSkillSuggestions] = useState(true)
  const [autoRecovery, setAutoRecovery] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const [filesystemScope, setFilesystemScope] = useState<'workspace' | 'machine'>('workspace')
  const [voiceId, setVoiceId] = useState('')
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false)
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState('')  // '' = default (30m)
  const [heartbeatModel, setHeartbeatModel] = useState('')
  const [heartbeatPrompt, setHeartbeatPrompt] = useState('')
  const [orchestratorEnabled, setOrchestratorEnabled] = useState(false)
  const [orchestratorMission, setOrchestratorMission] = useState('')
  const [orchestratorWakeInterval, setOrchestratorWakeInterval] = useState('5m')
  const [orchestratorGovernance, setOrchestratorGovernance] = useState<'autonomous' | 'approval-required' | 'notify-only'>('autonomous')
  const [orchestratorMaxCyclesPerDay, setOrchestratorMaxCyclesPerDay] = useState<string>('')
  const [sessionResetMode, setSessionResetMode] = useState<'' | 'idle' | 'daily' | 'isolated'>('')
  const [sessionIdleTimeoutSec, setSessionIdleTimeoutSec] = useState('')
  const [sessionMaxAgeSec, setSessionMaxAgeSec] = useState('')
  const [sessionDailyResetAt, setSessionDailyResetAt] = useState('')
  const [sessionResetTimezone, setSessionResetTimezone] = useState('')
  const [identityPersonaLabel, setIdentityPersonaLabel] = useState('')
  const [identitySelfSummary, setIdentitySelfSummary] = useState('')
  const [identityRelationshipSummary, setIdentityRelationshipSummary] = useState('')
  const [identityToneStyle, setIdentityToneStyle] = useState('')
  const [identityBoundariesText, setIdentityBoundariesText] = useState('')
  const [identityContinuityNotesText, setIdentityContinuityNotesText] = useState('')
  const [budgetEnabled, setBudgetEnabled] = useState(false)
  const [hourlyBudget, setHourlyBudget] = useState('')
  const [dailyBudget, setDailyBudget] = useState('')
  const [monthlyBudget, setMonthlyBudget] = useState('')
  const [budgetAction, setBudgetAction] = useState<'warn' | 'block'>('warn')
  const [agentWallets, setAgentWallets] = useState<SafeAgentWallet[]>([])
  const [addingKey, setAddingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  // Test connection state
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [testErrorCode, setTestErrorCode] = useState<string | null>(null)
  const [testDeviceId, setTestDeviceId] = useState<string | null>(null)
  const [openclawDeviceId, setOpenclawDeviceId] = useState<string | null>(null)
  const [configCopied, setConfigCopied] = useState(false)

  const soulFileRef = useRef<HTMLInputElement>(null)
  const [soulLibraryOpen, setSoulLibraryOpen] = useState(false)
  const promptFileRef = useRef<HTMLInputElement>(null)
  const importFileRef = useRef<HTMLInputElement>(null)
  const lastAutoSyncedModelsKeyRef = useRef<string | null>(null)
  const skipAutoModelRef = useRef(false)
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false)

  const handleFileUpload = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setter(ev.target?.result as string)
    reader.readAsText(file)
    e.target.value = ''
  }

  const loadAgentWallets = useCallback(async (agentId: string) => {
    try {
      const wallets = await api<Record<string, SafeAgentWallet>>('GET', `/wallets?agentId=${encodeURIComponent(agentId)}`)
      const matches = Object.values(wallets)
        .filter((wallet) => wallet.agentId === agentId)
        .sort((a, b) => {
          if ((a.isActive ? 1 : 0) !== (b.isActive ? 1 : 0)) return a.isActive ? -1 : 1
          return a.chain.localeCompare(b.chain)
        })
      setAgentWallets(matches)
    } catch {
      setAgentWallets([])
    }
  }, [])

  const agentSelectableProviders = useMemo(
    () => buildAgentSelectableProviders(providers, providerConfigs),
    [providers, providerConfigs],
  )
  const currentProvider = agentSelectableProviders.find((p) => p.id === provider)
  const providerCredentials = useMemo(
    () => resolveAgentSelectableProviderCredentials(provider, credentials, providerConfigs),
    [credentials, provider, providerConfigs],
  )
  const openclawCredentials = Object.values(credentials).filter((c) => c.provider === 'openclaw')
  const openclawGatewayProfiles = gatewayProfiles.filter((item) => item.provider === 'openclaw')
  const setAgentPrefill = useAppStore((s) => s.setAgentPrefill)
  const editing = editingId ? agents[editingId] : null
  const hasNativeCapabilities = NATIVE_CAPABILITY_PROVIDER_IDS.has(provider)
  const globalVoiceId = typeof appSettings.elevenLabsVoiceId === 'string' ? appSettings.elevenLabsVoiceId.trim() : ''
  const agentVoiceId = voiceId.trim()
  const elevenLabsConfigured = appSettings.elevenLabsApiKeyConfigured === true
  const voiceControlsAvailable = elevenLabsConfigured || appSettings.elevenLabsEnabled === true || !!globalVoiceId || !!agentVoiceId
  const voicePlaybackEnabled = appSettings.elevenLabsEnabled === true
  const effectiveVoiceId = agentVoiceId || globalVoiceId || FALLBACK_ELEVENLABS_VOICE_ID
  const effectiveVoiceSource = agentVoiceId
    ? 'Agent override'
    : globalVoiceId
      ? 'Global default'
      : 'Built-in fallback'
  const syncLiveProviderModels = useCallback(async (
    providerId: string,
    nextCredentialId: string | null,
    nextEndpoint: string | null,
    nextOllamaMode: 'local' | 'cloud',
    force = false,
  ): Promise<{ synced: boolean; models: string[] } | null> => {
    if (openclawEnabled) return null
    if (!AUTO_SYNC_MODEL_PROVIDER_IDS.has(providerId as ProviderType)) return null
    const providerInfo = agentSelectableProviders.find((item) => item.id === providerId)
    if (!providerInfo?.supportsModelDiscovery) return null

    const result = await fetchProviderModelDiscovery({
      providerId,
      credentialId: nextCredentialId,
      endpoint: nextEndpoint,
      ollamaMode: providerId === 'ollama' ? nextOllamaMode : null,
      force,
    })

    if (!result.ok || result.models.length === 0) return { synced: false, models: result.models }

    const sameModels = providerInfo.models.length === result.models.length
      && providerInfo.models.every((item, index) => item === result.models[index])

    if (!sameModels) {
      await api('PUT', `/providers/${providerId}/models`, { models: result.models })
      await loadProviders()
    }

    setModel((currentModel) => currentModel.trim() || result.models[0] || '')
    return { synced: !sameModels, models: result.models }
  }, [agentSelectableProviders, loadProviders, openclawEnabled])

  const providerNeedsKey = !editing && (
    (currentProvider?.requiresApiKey && providerCredentials.length === 0 && !addingKey) ||
    (provider === 'ollama' && ollamaMode === 'cloud' && providerCredentials.length === 0 && !addingKey)
  )

  useEffect(() => {
    if (!open) {
      lastAutoSyncedModelsKeyRef.current = null
      return
    }
    if (openclawEnabled) return
    if (!AUTO_SYNC_MODEL_PROVIDER_IDS.has(provider as ProviderType)) return
    if (!currentProvider?.supportsModelDiscovery) return

    const requiresCredential = currentProvider.requiresApiKey || (provider === 'ollama' && ollamaMode === 'cloud')
    if (requiresCredential && !credentialId) return

    const syncKey = `${provider}::${credentialId || ''}::${apiEndpoint?.trim() || ''}::${provider === 'ollama' ? ollamaMode : ''}`
    if (lastAutoSyncedModelsKeyRef.current === syncKey) return
    lastAutoSyncedModelsKeyRef.current = syncKey

    void syncLiveProviderModels(provider, credentialId, apiEndpoint, ollamaMode, false).catch(() => {})
  }, [apiEndpoint, credentialId, currentProvider, ollamaMode, open, openclawEnabled, provider, syncLiveProviderModels])

  useEffect(() => {
    if (open) {
      loadSettings()
      loadProviders()
      loadProviderConfigs()
      loadGatewayProfiles()
      loadCredentials()
      loadSkills()
      loadProjects()
      loadClaudeSkills()
      // Fetch enabled extension IDs so we can filter tool toggles
      api<{ enabledExtensionIds: string[] }>('GET', '/extensions/builtins')
        .then((res) => { if (res?.enabledExtensionIds) setEnabledExtensionIds(new Set(res.enabledExtensionIds)) })
        .catch(() => {})
      setTestStatus('idle')
      setTestMessage('')
      setShowAdvancedSettings(false)
      if (editing) {
        setName(editing.name)
        setDescription(editing.description)
        setSoul(editing.soul || '')
        setSoulInitial(editing.soul || '')
        setSoulSaveState('idle')
        setSystemPrompt(editing.systemPrompt)
        setProvider(editing.provider)
        setModel(editing.model)
        setCredentialId(editing.credentialId || null)
        setApiEndpoint(editing.apiEndpoint || null)
        setGatewayProfileId(editing.gatewayProfileId || null)
        setPreferredGatewayTagsText(formatGatewayTagList(editing.preferredGatewayTags))
        setPreferredGatewayUseCase(editing.preferredGatewayUseCase || '')
        setRoutingStrategy(editing.routingStrategy || 'single')
        setRoutingTargets(editing.routingTargets || [])
        setRole(editing.role === 'coordinator' ? 'coordinator' : 'worker')
        setDelegationEnabled(editing.delegationEnabled === true)
        setDelegationTargetMode(editing.delegationTargetMode === 'selected' ? 'selected' : 'all')
        setDelegationTargetAgentIds(editing.delegationTargetAgentIds || [])
        setTools(getEnabledToolIds(editing))
        setExtensions(getEnabledExtensionIds(editing))
        setSkills(editing.skills || [])
        setSkillIds(editing.skillIds || [])
        setMcpServerIds(editing.mcpServerIds || [])
        setMcpDisabledTools(editing.mcpDisabledTools || [])
        setFallbackCredentialIds(editing.fallbackCredentialIds || [])
        setCapabilities(Array.isArray(editing.capabilities) ? editing.capabilities : [])
        setCapInput('')
        setOllamaMode(resolveStoredOllamaMode({
          ollamaMode: editing.ollamaMode ?? null,
          apiEndpoint: editing.apiEndpoint ?? null,
        }))
        setOpenclawEnabled(editing.provider === 'openclaw')
        setProjectId(editing.projectId)
        setAvatarSeed(editing.avatarSeed || Math.random().toString(36).slice(2, 10))
        setAvatarUrl(editing.avatarUrl || null)
        setThinkingLevel(editing.thinkingLevel || '')
        setMemoryScopeMode(editing.memoryScopeMode || 'auto')
        setMemoryTierPreference(editing.memoryTierPreference || 'blended')
        setProactiveMemory(editing.proactiveMemory !== false)
        setAutoDraftSkillSuggestions(editing.autoDraftSkillSuggestions !== false)
        setAutoRecovery(editing.autoRecovery || false)
        setDisabled(editing.disabled === true)
        setFilesystemScope(editing.filesystemScope === 'machine' ? 'machine' : 'workspace')
        setVoiceId(editing.elevenLabsVoiceId || '')
        setHeartbeatEnabled(editing.heartbeatEnabled || false)
        setHeartbeatIntervalSec(parseDurationToSec(editing.heartbeatInterval, editing.heartbeatIntervalSec))
        setHeartbeatModel(editing.heartbeatModel || '')
        setHeartbeatPrompt(editing.heartbeatPrompt || '')
        setOrchestratorEnabled(editing.orchestratorEnabled || false)
        setOrchestratorMission(editing.orchestratorMission || '')
        setOrchestratorWakeInterval(typeof editing.orchestratorWakeInterval === 'string' ? editing.orchestratorWakeInterval : typeof editing.orchestratorWakeInterval === 'number' ? `${editing.orchestratorWakeInterval}s` : '5m')
        setOrchestratorGovernance(editing.orchestratorGovernance || 'autonomous')
        setOrchestratorMaxCyclesPerDay(editing.orchestratorMaxCyclesPerDay != null ? String(editing.orchestratorMaxCyclesPerDay) : '')
        setSessionResetMode(editing.sessionResetMode || '')
        setSessionIdleTimeoutSec(editing.sessionIdleTimeoutSec != null ? String(editing.sessionIdleTimeoutSec) : '')
        setSessionMaxAgeSec(editing.sessionMaxAgeSec != null ? String(editing.sessionMaxAgeSec) : '')
        setSessionDailyResetAt(editing.sessionDailyResetAt || '')
        setSessionResetTimezone(editing.sessionResetTimezone || '')
        setIdentityPersonaLabel(editing.identityState?.personaLabel || '')
        setIdentitySelfSummary(editing.identityState?.selfSummary || '')
        setIdentityRelationshipSummary(editing.identityState?.relationshipSummary || '')
        setIdentityToneStyle(editing.identityState?.toneStyle || '')
        setIdentityBoundariesText(formatIdentityList(editing.identityState?.boundaries))
        setIdentityContinuityNotesText(formatIdentityList(editing.identityState?.continuityNotes))
        setBudgetEnabled(
          (typeof editing.hourlyBudget === 'number' && editing.hourlyBudget > 0)
          || (typeof editing.dailyBudget === 'number' && editing.dailyBudget > 0)
          || (typeof editing.monthlyBudget === 'number' && editing.monthlyBudget > 0),
        )
        setHourlyBudget(typeof editing.hourlyBudget === 'number' && editing.hourlyBudget > 0 ? String(editing.hourlyBudget) : '')
        setDailyBudget(typeof editing.dailyBudget === 'number' && editing.dailyBudget > 0 ? String(editing.dailyBudget) : '')
        setMonthlyBudget(typeof editing.monthlyBudget === 'number' && editing.monthlyBudget > 0 ? String(editing.monthlyBudget) : '')
        setBudgetAction(editing.budgetAction || 'warn')
        void loadAgentWallets(editing.id)
      } else if (useAppStore.getState().agentPrefill) {
        // Duplicate mode — prefill from source agent, then clear
        const src = useAppStore.getState().agentPrefill!
        setAgentPrefill(null)
        skipAutoModelRef.current = true
        setName(`${src.name || 'Agent'} (Copy)`)
        setDescription(src.description || '')
        setSoul(src.soul || '')
        setSoulInitial(src.soul || '')
        setSoulSaveState('idle')
        setSystemPrompt(src.systemPrompt || '')
        setProvider(src.provider || 'claude-cli')
        setModel(src.model || '')
        setCredentialId(src.credentialId || null)
        setApiEndpoint(src.apiEndpoint || null)
        setGatewayProfileId(src.gatewayProfileId || null)
        setPreferredGatewayTagsText(formatGatewayTagList(src.preferredGatewayTags))
        setPreferredGatewayUseCase(src.preferredGatewayUseCase || '')
        setRoutingStrategy(src.routingStrategy || 'single')
        setRoutingTargets(src.routingTargets || [])
        setRole(src.role === 'coordinator' ? 'coordinator' : 'worker')
        setDelegationEnabled(src.delegationEnabled === true)
        setDelegationTargetMode(src.delegationTargetMode === 'selected' ? 'selected' : 'all')
        setDelegationTargetAgentIds(src.delegationTargetAgentIds || [])
        setTools(getEnabledToolIds(src))
        setExtensions(getEnabledExtensionIds(src))
        setSkills(src.skills || [])
        setSkillIds(src.skillIds || [])
        setMcpServerIds(src.mcpServerIds || [])
        setMcpDisabledTools(src.mcpDisabledTools || [])
        setFallbackCredentialIds(src.fallbackCredentialIds || [])
        setCapabilities(Array.isArray(src.capabilities) ? src.capabilities : [])
        setCapInput('')
        setOllamaMode(resolveStoredOllamaMode({
          ollamaMode: src.ollamaMode ?? null,
          apiEndpoint: src.apiEndpoint ?? null,
        }))
        setOpenclawEnabled(src.provider === 'openclaw')
        setProjectId(src.projectId)
        setAvatarSeed(Math.random().toString(36).slice(2, 10))
        setAvatarUrl(null)
        setThinkingLevel(src.thinkingLevel || '')
        setMemoryScopeMode(src.memoryScopeMode || 'auto')
        setMemoryTierPreference(src.memoryTierPreference || 'blended')
        setProactiveMemory(src.proactiveMemory !== false)
        setAutoDraftSkillSuggestions(src.autoDraftSkillSuggestions !== false)
        setAutoRecovery(src.autoRecovery || false)
        setDisabled(false)
        setFilesystemScope(src.filesystemScope === 'machine' ? 'machine' : 'workspace')
        setVoiceId(src.elevenLabsVoiceId || '')
        setHeartbeatEnabled(src.heartbeatEnabled || false)
        setHeartbeatIntervalSec(parseDurationToSec(src.heartbeatInterval, src.heartbeatIntervalSec))
        setHeartbeatModel(src.heartbeatModel || '')
        setHeartbeatPrompt(src.heartbeatPrompt || '')
        setOrchestratorEnabled(src.orchestratorEnabled || false)
        setOrchestratorMission(src.orchestratorMission || '')
        setOrchestratorWakeInterval(typeof src.orchestratorWakeInterval === 'string' ? src.orchestratorWakeInterval : typeof src.orchestratorWakeInterval === 'number' ? `${src.orchestratorWakeInterval}s` : '5m')
        setOrchestratorGovernance(src.orchestratorGovernance || 'autonomous')
        setOrchestratorMaxCyclesPerDay(src.orchestratorMaxCyclesPerDay != null ? String(src.orchestratorMaxCyclesPerDay) : '')
        setSessionResetMode(src.sessionResetMode || '')
        setSessionIdleTimeoutSec(src.sessionIdleTimeoutSec != null ? String(src.sessionIdleTimeoutSec) : '')
        setSessionMaxAgeSec(src.sessionMaxAgeSec != null ? String(src.sessionMaxAgeSec) : '')
        setSessionDailyResetAt(src.sessionDailyResetAt || '')
        setSessionResetTimezone(src.sessionResetTimezone || '')
        setIdentityPersonaLabel(src.identityState?.personaLabel || '')
        setIdentitySelfSummary(src.identityState?.selfSummary || '')
        setIdentityRelationshipSummary(src.identityState?.relationshipSummary || '')
        setIdentityToneStyle(src.identityState?.toneStyle || '')
        setIdentityBoundariesText(formatIdentityList(src.identityState?.boundaries))
        setIdentityContinuityNotesText(formatIdentityList(src.identityState?.continuityNotes))
        setBudgetEnabled(
          (typeof src.hourlyBudget === 'number' && src.hourlyBudget > 0)
          || (typeof src.dailyBudget === 'number' && src.dailyBudget > 0)
          || (typeof src.monthlyBudget === 'number' && src.monthlyBudget > 0),
        )
        setHourlyBudget(typeof src.hourlyBudget === 'number' && src.hourlyBudget > 0 ? String(src.hourlyBudget) : '')
        setDailyBudget(typeof src.dailyBudget === 'number' && src.dailyBudget > 0 ? String(src.dailyBudget) : '')
        setMonthlyBudget(typeof src.monthlyBudget === 'number' && src.monthlyBudget > 0 ? String(src.monthlyBudget) : '')
        setBudgetAction(src.budgetAction || 'warn')
        setAgentWallets([])
      } else {
        setName('')
        setDescription('')
        const newSoul = randomSoul()
        setSoul(newSoul)
        setSoulInitial(newSoul)
        setSoulSaveState('idle')
        setSystemPrompt('')
        setProvider('claude-cli')
        setModel('')
        setCredentialId(null)
        setApiEndpoint(null)
        setGatewayProfileId(null)
        setPreferredGatewayTagsText('')
        setPreferredGatewayUseCase('')
        setRoutingStrategy('single')
        setRoutingTargets([])
        setRole('worker')
        setDelegationEnabled(false)
        setDelegationTargetMode('all')
        setDelegationTargetAgentIds([])
        setTools(getDefaultAgentToolIds())
        setExtensions([])
        setSkills([])
        setSkillIds([])
        setMcpDisabledTools([])
        setFallbackCredentialIds([])
        setCapabilities([])
        setCapInput('')
        setOllamaMode('local')
        setOpenclawEnabled(false)
        setProjectId(undefined)
        setAvatarSeed('')
        setThinkingLevel('')
        setMemoryScopeMode('auto')
        setMemoryTierPreference('blended')
        setProactiveMemory(true)
        setAutoDraftSkillSuggestions(true)
        setAutoRecovery(false)
        setDisabled(false)
        setVoiceId('')
        setHeartbeatEnabled(true)
        setHeartbeatIntervalSec('')
        setHeartbeatModel('')
        setHeartbeatPrompt('')
        setOrchestratorEnabled(false)
        setOrchestratorMission('')
        setOrchestratorWakeInterval('5m')
        setOrchestratorGovernance('autonomous')
        setOrchestratorMaxCyclesPerDay('')
        setSessionResetMode('')
        setSessionIdleTimeoutSec('')
        setSessionMaxAgeSec('')
        setSessionDailyResetAt('')
        setSessionResetTimezone('')
        setIdentityPersonaLabel('')
        setIdentitySelfSummary('')
        setIdentityRelationshipSummary('')
        setIdentityToneStyle('')
        setIdentityBoundariesText('')
        setIdentityContinuityNotesText('')
        setBudgetEnabled(false)
        setHourlyBudget('')
        setDailyBudget('')
        setMonthlyBudget('')
        setBudgetAction('warn')
        setAgentWallets([])
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId])

  useEffect(() => {
    if (skipAutoModelRef.current) {
      skipAutoModelRef.current = false
      return
    }
    if (currentProvider?.models.length && !editing) {
      setModel(currentProvider.models[0])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, agentSelectableProviders])

  // Reset test status when connection params change
  useEffect(() => {
    setTestStatus('idle')
    setTestMessage('')
  }, [provider, credentialId, apiEndpoint])

  // Fetch MCP tools when selected servers change
  useEffect(() => {
    if (!mcpServerIds.length) {
      setMcpTools({})
      return
    }
    let cancelled = false
    setMcpToolsLoading(true)
    Promise.all(
      mcpServerIds.map(async (id) => {
        try {
          const tools = await api<{ name: string; description: string }[]>('GET', `/mcp-servers/${id}/tools`)
          return { id, tools: Array.isArray(tools) ? tools : [] }
        } catch {
          return { id, tools: [] }
        }
      })
    ).then((results) => {
      if (cancelled) return
      const map: Record<string, { name: string; description: string }[]> = {}
      for (const r of results) map[r.id] = r.tools
      setMcpTools(map)
      setMcpToolsLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpServerIds.join(',')])

  // Fetch OpenClaw device ID when toggle is enabled
  useEffect(() => {
    if (!openclawEnabled) return
    let cancelled = false
    api<{ deviceId: string }>('GET', '/setup/openclaw-device').then((res) => {
      if (!cancelled && res.deviceId) setOpenclawDeviceId(res.deviceId)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [openclawEnabled])

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  const applyGatewayProfileSelection = (nextGatewayProfileId: string | null) => {
    setGatewayProfileId(nextGatewayProfileId)
    const gateway = openclawGatewayProfiles.find((item) => item.id === nextGatewayProfileId)
    if (!gateway) return
    setProvider('openclaw')
    setOpenclawEnabled(true)
    setApiEndpoint(gateway.endpoint)
    if (gateway.credentialId) setCredentialId(gateway.credentialId)
    if (!model) setModel('default')
  }

  const updateRoutingTarget = (targetId: string, patch: Partial<AgentRoutingTarget>) => {
    setRoutingTargets((current) => current.map((target) => (
      target.id === targetId
        ? { ...target, ...patch }
        : target
    )))
  }

  const removeRoutingTarget = (targetId: string) => {
    setRoutingTargets((current) => current.filter((target) => target.id !== targetId))
  }

  const addRoutingTargetFromCurrent = () => {
    const nextTarget: AgentRoutingTarget = {
      id: Math.random().toString(16).slice(2, 10),
      label: routingTargets.length === 0 ? 'Primary route' : `Route ${routingTargets.length + 1}`,
      role: routingTargets.length === 0 ? 'primary' : 'backup',
      provider,
      model,
      ollamaMode: provider === 'ollama' ? ollamaMode : null,
      credentialId,
      fallbackCredentialIds,
      apiEndpoint,
      gatewayProfileId,
      preferredGatewayTags: parseGatewayTagList(preferredGatewayTagsText),
      preferredGatewayUseCase: preferredGatewayUseCase || null,
      priority: routingTargets.length + 1,
    }
    setRoutingTargets((current) => [...current, nextTarget])
  }

  const handleSave = async () => {
    // For any endpoint, just ensure bare host:port gets a protocol prepended
    let normalizedEndpoint = apiEndpoint
    if (normalizedEndpoint) {
      const url = normalizedEndpoint.trim().replace(/\/+$/, '')
      normalizedEndpoint = /^(https?|wss?):\/\//i.test(url) ? url : `http://${url}`
    }
    const parsedHourlyBudget = budgetEnabled && hourlyBudget ? Number(hourlyBudget) : null
    const parsedDailyBudget = budgetEnabled && dailyBudget ? Number(dailyBudget) : null
    const parsedMonthlyBudget = budgetEnabled && monthlyBudget ? Number(monthlyBudget) : null
    const parsedSessionIdleTimeoutSec = sessionIdleTimeoutSec ? Number(sessionIdleTimeoutSec) : null
    const parsedSessionMaxAgeSec = sessionMaxAgeSec ? Number(sessionMaxAgeSec) : null
    const identityBoundaries = parseIdentityList(identityBoundariesText)
    const identityContinuityNotes = parseIdentityList(identityContinuityNotesText)
    const identityState = (() => {
      const value = {
        personaLabel: identityPersonaLabel.trim() || undefined,
        selfSummary: identitySelfSummary.trim() || undefined,
        relationshipSummary: identityRelationshipSummary.trim() || undefined,
        toneStyle: identityToneStyle.trim() || undefined,
        boundaries: identityBoundaries.length ? identityBoundaries : undefined,
        continuityNotes: identityContinuityNotes.length ? identityContinuityNotes : undefined,
      }
      return Object.values(value).some((entry) => Array.isArray(entry) ? entry.length > 0 : Boolean(entry)) ? value : null
    })()
    const data = {
      name: name.trim() || 'Unnamed Agent',
      description,
      soul,
      systemPrompt,
      provider,
      model,
      ollamaMode: provider === 'ollama' ? ollamaMode : null,
      credentialId,
      apiEndpoint: normalizedEndpoint,
      gatewayProfileId,
      preferredGatewayTags: parseGatewayTagList(preferredGatewayTagsText),
      preferredGatewayUseCase: preferredGatewayUseCase || null,
      routingStrategy,
      routingTargets: routingTargets.map((target, index) => ({
        ...target,
        ollamaMode: target.provider === 'ollama'
          ? resolveStoredOllamaMode({
            ollamaMode: target.ollamaMode ?? null,
            apiEndpoint: target.apiEndpoint ?? null,
          })
          : null,
        preferredGatewayTags: parseGatewayTagList(formatGatewayTagList(target.preferredGatewayTags)),
        preferredGatewayUseCase: target.preferredGatewayUseCase || null,
        priority: typeof target.priority === 'number' ? target.priority : index + 1,
      })),
      role,
      delegationEnabled: role === 'coordinator' ? true : delegationEnabled,
      delegationTargetMode: delegationEnabled || role === 'coordinator' ? delegationTargetMode : 'all',
      delegationTargetAgentIds: (delegationEnabled || role === 'coordinator') && delegationTargetMode === 'selected' ? delegationTargetAgentIds : [],
      tools,
      extensions,
      skills,
      skillIds,
      mcpServerIds,
      mcpDisabledTools: mcpDisabledTools.length ? mcpDisabledTools : undefined,
      fallbackCredentialIds,
      capabilities,
      projectId: projectId || undefined,
      avatarSeed: avatarSeed.trim() || undefined,
      avatarUrl: avatarUrl || null,
      thinkingLevel: thinkingLevel || undefined,
      memoryScopeMode,
      memoryTierPreference,
      proactiveMemory,
      autoDraftSkillSuggestions,
      autoRecovery,
      disabled,
      filesystemScope: filesystemScope === 'machine' ? 'machine' as const : undefined,
      elevenLabsVoiceId: voiceId.trim() || null,
      heartbeatEnabled,
      heartbeatInterval: heartbeatIntervalSec ? formatHbDuration(Number(heartbeatIntervalSec)) : null,
      heartbeatIntervalSec: heartbeatIntervalSec ? Number(heartbeatIntervalSec) : null,
      heartbeatModel: heartbeatModel.trim() || null,
      heartbeatPrompt: heartbeatPrompt.trim() || null,
      orchestratorEnabled,
      orchestratorMission: orchestratorMission.trim() || undefined,
      orchestratorWakeInterval: orchestratorWakeInterval.trim() || null,
      orchestratorGovernance,
      orchestratorMaxCyclesPerDay: orchestratorMaxCyclesPerDay ? Number(orchestratorMaxCyclesPerDay) : null,
      identityState,
      sessionResetMode: sessionResetMode || null,
      sessionIdleTimeoutSec: Number.isFinite(parsedSessionIdleTimeoutSec) && parsedSessionIdleTimeoutSec! >= 0 ? parsedSessionIdleTimeoutSec : null,
      sessionMaxAgeSec: Number.isFinite(parsedSessionMaxAgeSec) && parsedSessionMaxAgeSec! >= 0 ? parsedSessionMaxAgeSec : null,
      sessionDailyResetAt: sessionDailyResetAt.trim() || null,
      sessionResetTimezone: sessionResetTimezone.trim() || null,
      hourlyBudget: parsedHourlyBudget && parsedHourlyBudget > 0 ? parsedHourlyBudget : null,
      dailyBudget: parsedDailyBudget && parsedDailyBudget > 0 ? parsedDailyBudget : null,
      monthlyBudget: parsedMonthlyBudget && parsedMonthlyBudget > 0 ? parsedMonthlyBudget : null,
      budgetAction: budgetEnabled ? budgetAction : undefined,
    }
    if (WORKER_ONLY_PROVIDER_IDS.has(provider)) {
      data.role = 'worker'
      data.delegationEnabled = false
      data.heartbeatEnabled = false
      data.heartbeatInterval = null
      data.heartbeatIntervalSec = null
      data.heartbeatModel = null
      data.heartbeatPrompt = null
    }
    const savedAgent = editing
      ? await updateAgent(editing.id, data)
      : await createAgent(data)
    updateAgentInStore(savedAgent)
    if (editing) {
      toast.success('Agent saved')
    } else {
      toast.success('Agent created')
    }
    await loadAgents()
    if (
      editing
      && activeSessionId
      && currentSession?.agentId === editing.id
      && (
        currentSession.shortcutForAgentId === editing.id
        || activeSessionId === editing.threadSessionId
      )
    ) {
      await refreshSession(activeSessionId)
    }
    setSoulInitial(soul)
    setSoulSaveState('saved')
    setTimeout(() => setSoulSaveState('idle'), 1500)
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await deleteAgent(editing.id)
      toast.success('Agent moved to trash')
      await loadAgents()
      onClose()
    }
  }

  const handleExport = () => {
    if (!editing) return
    const recommendedProviders = agentSelectableProviders.some((providerOption) => (
      providerOption.id === editing.provider && providerOption.type === 'builtin'
    ))
      ? [editing.provider as ProviderType]
      : undefined
    const pack: AgentPackManifest = {
      schemaVersion: 1,
      kind: 'swarmclaw-agent-pack',
      name: `${editing.name} Pack`,
      description: editing.description || undefined,
      exportedAt: Date.now(),
      recommendedProviders,
      agents: [{
        id: editing.name.replace(/\s+/g, '-').toLowerCase(),
        name: editing.name,
        description: editing.description || undefined,
        provider: editing.provider,
        model: editing.model,
        ollamaMode: editing.provider === 'ollama' ? (editing.ollamaMode || 'local') : null,
        credentialId: editing.credentialId || null,
        fallbackCredentialIds: editing.fallbackCredentialIds || [],
        apiEndpoint: editing.apiEndpoint || null,
        gatewayProfileId: editing.gatewayProfileId || null,
        routingStrategy: editing.routingStrategy || null,
        routingTargets: editing.routingTargets || [],
        tools: getEnabledToolIds(editing),
        extensions: getEnabledExtensionIds(editing),
        capabilities: editing.capabilities,
        elevenLabsVoiceId: editing.elevenLabsVoiceId || null,
        soul: editing.soul,
        systemPrompt: editing.systemPrompt,
      }],
    }
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${editing.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.agent-pack.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Agent pack exported')
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        const importedAgent = data?.kind === 'swarmclaw-agent-pack'
          ? data?.agents?.[0]
          : data
        if (!importedAgent || typeof importedAgent !== 'object') throw new Error('Invalid agent pack')
        // Strip IDs and timestamps
        const { id: _id, createdAt: _ca, updatedAt: _ua, threadSessionId: _ts, ...agentData } = importedAgent
        void [_id, _ca, _ua, _ts]
        await createAgent({ ...agentData, name: agentData.name || 'Imported Agent' })
        await loadAgents()
        toast.success(data?.kind === 'swarmclaw-agent-pack' ? 'Agent pack imported' : 'Agent imported')
        onClose()
      } catch {
        toast.error('Invalid agent JSON file')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleTestConnection = async (): Promise<boolean> => {
    setTestStatus('testing')
    setTestMessage('')
    setTestErrorCode(null)
    try {
      const result = await api<{ ok: boolean; message: string; errorCode?: string; deviceId?: string }>('POST', '/setup/check-provider', {
        provider,
        credentialId,
        endpoint: apiEndpoint,
        model,
        ollamaMode: provider === 'ollama' ? ollamaMode : null,
      }, {
        timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
      })
      if (result.deviceId) setTestDeviceId(result.deviceId)
      if (result.ok) {
        let syncedModels: string[] = []
        try {
          const synced = await syncLiveProviderModels(provider, credentialId, apiEndpoint, ollamaMode, true)
          syncedModels = synced?.models || []
        } catch {
          // Best-effort: a passing connection test should still pass if model sync fails.
        }
        setTestStatus('pass')
        setTestMessage(
          syncedModels.length > 0
            ? `${result.message} Synced ${syncedModels.length} live model${syncedModels.length === 1 ? '' : 's'} into the model picker.`
            : result.message,
        )
        return true
      } else {
        setTestStatus('fail')
        setTestMessage(result.message)
        setTestErrorCode(result.errorCode || null)
        toast.error(result.message || 'Connection test failed')
        return false
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connection test failed'
      setTestStatus('fail')
      setTestMessage(msg)
      toast.error(msg)
      return false
    }
  }

  // Whether this provider needs a connection test before saving.
  // Only CLI providers (no remote connection) skip the test.
  const needsTest = !providerNeedsKey && !NON_LANGGRAPH_PROVIDER_IDS.has(provider)

  const [saving, setSaving] = useState(false)

  const handleTestAndSave = async () => {
    if (needsTest) {
      const passed = await handleTestConnection()
      if (!passed) return
      if (!openclawEnabled) {
        // Brief pause so the user can see the success state on the button
        await sleep(1500)
      }
    }
    setSaving(true)
    await handleSave()
    setSaving(false)
  }

  const canDelegateToAgents = delegationEnabled || role === 'coordinator'
  const agentOptions = Object.values(agents).filter((p) => p.id !== editingId)
  const defaultAgentToolIds = useMemo(() => getDefaultAgentToolIds(), [])
  const toolsDifferFromDefault = tools.length !== defaultAgentToolIds.length
    || defaultAgentToolIds.some((toolId) => !tools.includes(toolId))
  const agentAdvancedBadges = useMemo(() => {
    const badges: string[] = []
    if (voiceId.trim()) badges.push('Voice')
    if (routingStrategy !== 'single' || routingTargets.length > 0 || fallbackCredentialIds.length > 0) badges.push('Routing')
    if (memoryScopeMode !== 'auto' || memoryTierPreference !== 'blended' || !proactiveMemory) badges.push('Memory')
    if (sessionResetMode || sessionIdleTimeoutSec || sessionMaxAgeSec || sessionDailyResetAt || sessionResetTimezone) badges.push('Session reset')
    if (identityPersonaLabel.trim() || identitySelfSummary.trim() || identityRelationshipSummary.trim() || identityToneStyle.trim()) badges.push('Continuity')
    if (skills.length > 0 || skillIds.length > 0 || mcpServerIds.length > 0 || mcpDisabledTools.length > 0) badges.push('Skills & MCP')
    if (toolsDifferFromDefault || filesystemScope === 'machine') badges.push('Tools')
    if (budgetEnabled) badges.push('Budget')
    if (disabled) badges.push('Disabled')
    if (autoRecovery) badges.push('Recovery')
    if (projectId) badges.push('Project')
    if (thinkingLevel) badges.push('Thinking')
    if (!autoDraftSkillSuggestions) badges.push('Skill drafting')
    return Array.from(new Set(badges))
  }, [
    autoDraftSkillSuggestions,
    autoRecovery,
    budgetEnabled,
    disabled,
    fallbackCredentialIds.length,
    filesystemScope,
    identityPersonaLabel,
    identityRelationshipSummary,
    identitySelfSummary,
    identityToneStyle,
    mcpDisabledTools.length,
    mcpServerIds.length,
    memoryScopeMode,
    memoryTierPreference,
    proactiveMemory,
    projectId,
    routingStrategy,
    routingTargets.length,
    sessionDailyResetAt,
    sessionIdleTimeoutSec,
    sessionMaxAgeSec,
    sessionResetMode,
    sessionResetTimezone,
    skillIds.length,
    skills.length,
    thinkingLevel,
    toolsDifferFromDefault,
    voiceId,
  ])
  const advancedSummary = agentAdvancedBadges.length > 0
    ? `${agentAdvancedBadges.length} configured`
    : 'Defaults only'

  const toggleAgent = (id: string) => {
    setDelegationTargetMode('selected')
    setDelegationTargetAgentIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      if (next.length === 0) {
        setDelegationTargetMode('all')
      }
      return next
    })
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <>
    <BottomSheet open={open} onClose={onClose} wide>
      <div className="mb-8 pr-14 sm:pr-20">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[28px] font-700 tracking-[-0.03em]">
              {editing ? 'Edit Agent' : 'New Agent'}
            </h2>
            <span className={`rounded-[999px] px-2.5 py-1 text-[10px] font-700 uppercase tracking-[0.1em] ${
              disabled
                ? 'border border-amber-400/20 bg-amber-400/[0.08] text-amber-300'
                : 'border border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300'
            }`}>
              {disabled ? 'Disabled' : 'Enabled'}
            </span>
          </div>
          <p className="text-[14px] text-text-3">Set up an agent with sensible defaults, then expand advanced settings if you need deeper control.</p>
        </div>
      </div>

      <SectionCard
        title="Basics"
        description="Start with the core identity and description users will see first."
      >
      <div className="mb-8">
        <SectionLabel>Name</SectionLabel>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SEO Researcher" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <SectionLabel>Avatar</SectionLabel>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="relative group shrink-0">
              <AgentAvatar seed={avatarUrl ? null : (avatarSeed || null)} avatarUrl={avatarUrl} name={name || 'A'} size={64} />
              <label className="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setUploading(true)
                    try {
                      const res = await fetch('/api/upload', {
                        method: 'POST',
                        headers: { 'x-filename': file.name },
                        body: await file.arrayBuffer(),
                      })
                      const data = await res.json()
                      if (data.url) {
                        setAvatarUrl(data.url)
                        setAvatarSeed('')
                        toast.success('Avatar image uploaded')
                      }
                    } catch {
                      toast.error('Failed to upload image')
                    } finally {
                      setUploading(false)
                      e.target.value = ''
                    }
                  }}
                />
              </label>
            </div>
            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setAvatarUrl(null)
                    if (!avatarSeed) setAvatarSeed(Math.random().toString(36).slice(2, 10))
                  }}
                  className="text-[11px] text-text-3 hover:text-red-400 transition-colors self-start cursor-pointer"
                >
                  Remove custom image
                </button>
              )}
              {uploading && <span className="text-[11px] text-text-3">Uploading...</span>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={avatarSeed}
              onChange={(e) => { setAvatarSeed(e.target.value); setAvatarUrl(null) }}
              placeholder="Avatar seed (any text)"
              className={inputClass}
              style={{ fontFamily: 'inherit', flex: 1 }}
            />
            <button
              type="button"
              onClick={() => { setAvatarSeed(Math.random().toString(36).slice(2, 10)); setAvatarUrl(null) }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-white/[0.04] hover:text-text-2 active:scale-95 shrink-0"
              style={{ fontFamily: 'inherit' }}
              title="Shuffle avatar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <circle cx="9" cy="9" r="1" fill="currentColor" />
                <circle cx="15" cy="15" r="1" fill="currentColor" />
              </svg>
              Shuffle
            </button>
          </div>
        </div>
      </div>

      <div className="mb-8">
        <SectionLabel>Description</SectionLabel>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this agent do?" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>
      </SectionCard>

      <SectionCard
        title="Model & Connection"
        description="Choose how this agent connects to a model, then verify the setup before saving."
      >
      <div className="mb-8">
        <div className="flex items-center justify-between gap-3 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-3">
          <div>
            <p className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3">Runtime</p>
            <p className="mt-1 text-[14px] font-600 text-text">{openclawEnabled ? 'OpenClaw gateway' : 'Direct provider connection'}</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-[11px] font-600 uppercase tracking-[0.08em] text-text-3">OpenClaw</label>
            <button
              type="button"
              onClick={() => {
                if (!openclawEnabled) {
                  setOpenclawEnabled(true)
                  setProvider('openclaw')
                  setModel('default')
                  if (!apiEndpoint) setApiEndpoint('http://localhost:18789')
                } else {
                  setOpenclawEnabled(false)
                  const first = agentSelectableProviders[0]?.id || 'claude-cli'
                  setProvider(first)
                  setModel('')
                  setApiEndpoint(null)
                  setCredentialId(null)
                  setGatewayProfileId(null)
                  setTestStatus('idle')
                  setTestMessage('')
                  setTestErrorCode(null)
                }
              }}
              className={`relative h-6 w-11 rounded-full border-none transition-colors duration-200 ${openclawEnabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
            >
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${openclawEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
        </div>
      </div>
      {/* OpenClaw Gateway Fields */}
      {openclawEnabled && (
        <div className="mb-8 space-y-5">
          {openclawGatewayProfiles.length > 0 && (
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Gateway Profile</label>
              <select
                value={gatewayProfileId || ''}
                onChange={(e) => applyGatewayProfileSelection(e.target.value || null)}
                className={inputClass}
              >
                <option value="">Custom endpoint</option>
                {openclawGatewayProfiles.map((gateway) => (
                  <option key={gateway.id} value={gateway.id}>
                    {gateway.name}{gateway.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* Connection fields */}
          <div className="space-y-4">
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Gateway URL</label>
              <input
                type="text"
                value={apiEndpoint || ''}
                onChange={(e) => setApiEndpoint(e.target.value || null)}
                placeholder="http://localhost:18789"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Gateway Token</label>
              {openclawCredentials.length > 0 && !addingKey ? (
                <div className="flex gap-2">
                  <select value={credentialId || ''} onChange={(e) => {
                    if (e.target.value === '__add__') {
                      setAddingKey(true)
                      setNewKeyName('')
                      setNewKeyValue('')
                    } else {
                      setCredentialId(e.target.value || null)
                    }
                  }} className={`${inputClass} appearance-none cursor-pointer flex-1`} style={{ fontFamily: 'inherit' }}>
                    <option value="">No token (auth disabled)</option>
                    {openclawCredentials.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value="__add__">+ Add new token...</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => { setAddingKey(true); setNewKeyName(''); setNewKeyValue('') }}
                    className="shrink-0 px-3 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
                  >
                    + New
                  </button>
                </div>
              ) : (
                <div className="space-y-3 p-4 rounded-[12px] border border-accent-bright/15 bg-accent-soft/10">
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Label (e.g. Local gateway)"
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <input
                    type="password"
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="Paste gateway token..."
                    className={inputClass}
                    style={{ fontFamily: 'inherit' }}
                  />
                  <div className="flex gap-2 justify-end">
                    {openclawCredentials.length > 0 && (
                      <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                    )}
                    <button
                      type="button"
                      disabled={savingKey || !newKeyValue.trim()}
                      onClick={async () => {
                        setSavingKey(true)
                        try {
                          const cred = await api<{ id: string }>('POST', '/credentials', { provider: 'openclaw', name: newKeyName.trim() || 'OpenClaw token', apiKey: newKeyValue.trim() })
                          await loadCredentials()
                          setCredentialId(cred.id)
                          setAddingKey(false)
                          setNewKeyName('')
                          setNewKeyValue('')
                        } catch (err: unknown) { toast.error(`Failed to save: ${errorMessage(err)}`) }
                        finally { setSavingKey(false) }
                      }}
                      className="px-4 py-1.5 rounded-[8px] bg-accent-bright text-white text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                      style={{ fontFamily: 'inherit' }}
                    >
                      {savingKey ? 'Saving...' : 'Save Token'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Insecure connection warning */}
          {(() => {
            const url = (apiEndpoint || '').trim().toLowerCase()
            const isRemote = url && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(url)
            const isSecure = /^(https|wss):\/\//i.test(url)
            if (isRemote && !isSecure) return (
              <div className="px-3 py-2.5 rounded-[10px] bg-[#fbbf24]/[0.06] border border-[#fbbf24]/20">
                <p className="text-[13px] text-[#fbbf24] leading-[1.5]">
                  Unencrypted connection. Use HTTPS or an SSH tunnel for production.
                </p>
              </div>
            )
            return null
          })()}

          {/* Status feedback — single unified block */}
          {testStatus === 'pass' && (
            <div className="p-4 rounded-[12px] bg-emerald-500/[0.06] border border-emerald-500/15 space-y-2">
              <div className="flex items-center gap-2">
                <StatusDot status="online" />
                <p className="text-[14px] text-emerald-400 font-600">Connected</p>
              </div>
              <p className="text-[13px] text-text-2/80 leading-[1.6]">Gateway is reachable and this device is paired. Tools and models are managed by the OpenClaw instance.</p>
            </div>
          )}
          {testStatus === 'fail' && (
            <div className="p-4 rounded-[12px] border space-y-3"
              style={{
                background: testErrorCode === 'PAIRING_REQUIRED' ? 'rgba(34,197,94,0.04)' : 'rgba(var(--accent-bright-rgb,120,100,255),0.06)',
                borderColor: testErrorCode === 'PAIRING_REQUIRED' ? 'rgba(34,197,94,0.2)' : 'rgba(var(--accent-bright-rgb,120,100,255),0.15)',
              }}
            >
              {testErrorCode === 'PAIRING_REQUIRED' ? (<>
                <div className="flex items-center gap-2">
                  <StatusDot status="online" pulse />
                  <p className="text-[14px] text-[#22c55e] font-600">Awaiting Approval</p>
                </div>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  This device is pending approval on your gateway. Go to <span className="text-text-2 font-500">Nodes</span>, approve the device{(testDeviceId || openclawDeviceId) ? <> (<code className="text-[12px] font-mono text-text-2/70">{(testDeviceId || openclawDeviceId)!.slice(0, 12)}...</code>)</> : null}, then click <span className="text-text-2 font-500">Retry Connection</span>.
                </p>
                <a
                  href={(() => { const ep = (apiEndpoint || 'http://localhost:18789').replace(/\/+$/, ''); return /^https?:\/\//i.test(ep) ? ep : `http://${ep}` })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-[10px] bg-white/[0.06] border border-white/[0.1] text-[13px] text-text-2 font-500 hover:bg-white/[0.1] transition-colors"
                >
                  Approve in Dashboard →
                </a>
              </>) : testErrorCode === 'DEVICE_AUTH_INVALID' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Device Not Paired</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  The gateway doesn&apos;t recognize this device. Go to <span className="text-text-2 font-500">Nodes</span>, and add or approve this device{(testDeviceId || openclawDeviceId) ? <> (<code className="text-[12px] font-mono text-text-2/70">{(testDeviceId || openclawDeviceId)!.slice(0, 12)}...</code>)</> : null}.
                </p>
                <a
                  href={(() => { const ep = (apiEndpoint || 'http://localhost:18789').replace(/\/+$/, ''); return /^https?:\/\//i.test(ep) ? ep : `http://${ep}` })()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 rounded-[10px] bg-white/[0.06] border border-white/[0.1] text-[13px] text-text-2 font-500 hover:bg-white/[0.1] transition-colors"
                >
                  Approve in Dashboard →
                </a>
              </>) : testErrorCode === 'AUTH_TOKEN_MISSING' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Token Required</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  This gateway requires an auth token. Add one above and try again.
                </p>
              </>) : testErrorCode === 'AUTH_TOKEN_INVALID' ? (<>
                <p className="text-[14px] text-accent-bright font-600">Invalid Token</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  The gateway rejected this token. Check that it matches the one configured on your OpenClaw instance.
                </p>
              </>) : (<>
                <p className="text-[14px] text-accent-bright font-600">Connection Failed</p>
                <p className="text-[13px] text-text-2/80 leading-[1.6]">
                  {testMessage || 'Could not reach the gateway. Check the URL, token, and that the gateway is running.'}
                </p>
              </>)}
              {/* Device ID footer — always shown on failure for debugging */}
              {(testDeviceId || openclawDeviceId) && testErrorCode !== 'AUTH_TOKEN_MISSING' && testErrorCode !== 'AUTH_TOKEN_INVALID' && (
                <div className="pt-2 border-t border-white/[0.04]">
                  <p className="text-[12px] text-text-3/70 flex items-center gap-1.5">
                    Device <code className="font-mono text-text-2/70 select-all">{(testDeviceId || openclawDeviceId)}</code>
                    <button
                      type="button"
                      onClick={() => {
                        void copyTextToClipboard((testDeviceId || openclawDeviceId)!).then((copiedId) => {
                          if (!copiedId) return
                          setConfigCopied(true)
                          setTimeout(() => setConfigCopied(false), 2000)
                        })
                      }}
                      className="text-[12px] text-text-3/60 hover:text-text-3/80 transition-colors cursor-pointer bg-transparent border-none"
                    >
                      {configCopied ? 'copied' : 'copy'}
                    </button>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!openclawEnabled && <div className="mb-8">
        <SectionLabel>Provider</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          {agentSelectableProviders.map((p) => {
            const nextCredentials = resolveAgentSelectableProviderCredentials(p.id, credentials, providerConfigs)
            const isConnected = !p.requiresApiKey || nextCredentials.length > 0
            return (
              <button
                key={p.id}
                onClick={() => {
                  setProvider(p.id)
                  if (!nextCredentials.some((item) => item.id === credentialId)) {
                    setCredentialId(nextCredentials[0]?.id || null)
                  }
                  setGatewayProfileId(null)
                }}
                className={`relative py-3.5 px-4 rounded-[14px] text-center cursor-pointer transition-all duration-200
                  active:scale-[0.97] text-[14px] font-600 border
                  ${provider === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-surface border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {isConnected && (
                  <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400" />
                )}
                {p.name}
              </button>
            )
          })}
        </div>
      </div>}

      {!openclawEnabled && currentProvider && currentProvider.models.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Model</SectionLabel>
          <ModelCombobox
            providerId={currentProvider.id}
            value={model}
            onChange={setModel}
            models={currentProvider.models}
            defaultModels={currentProvider.defaultModels}
            credentialId={credentialId}
            apiEndpoint={apiEndpoint}
            ollamaMode={provider === 'ollama' ? ollamaMode : null}
            supportsDiscovery={currentProvider.supportsModelDiscovery}
            className={`${inputClass} cursor-pointer`}
          />
        </div>
      )}

      {/* OpenClaw manages its own models — no selector needed */}

      {/* Ollama Mode Toggle */}
      {!openclawEnabled && provider === 'ollama' && (
        <div className="mb-8">
          <SectionLabel>Mode</SectionLabel>
          <div className="flex p-1 rounded-[14px] bg-surface border border-white/[0.06]">
            {(['local', 'cloud'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  setOllamaMode(mode)
                  if (mode === 'local') {
                    setApiEndpoint('http://localhost:11434')
                    setCredentialId(null)
                  } else {
                    setApiEndpoint(null)
                    if (providerCredentials.length > 0) setCredentialId(providerCredentials[0].id)
                  }
                }}
                className={`flex-1 py-3 rounded-[12px] text-center cursor-pointer transition-all duration-200
                  text-[14px] font-600 capitalize
                  ${ollamaMode === mode
                    ? 'bg-accent-soft text-accent-bright shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                    : 'bg-transparent text-text-3 hover:text-text-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      )}

      {!openclawEnabled && (currentProvider?.requiresApiKey || currentProvider?.optionalApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && (
        <div className="mb-8">
          <SectionLabel>API Key{currentProvider?.optionalApiKey && !currentProvider?.requiresApiKey && <span className="normal-case tracking-normal font-normal text-text-3"> (optional)</span>}</SectionLabel>
          {providerCredentials.length > 0 && !addingKey ? (
            <div className="flex gap-2">
              <select value={credentialId || ''} onChange={(e) => {
                if (e.target.value === '__add__') {
                  setAddingKey(true)
                  setNewKeyName('')
                  setNewKeyValue('')
                } else {
                  setCredentialId(e.target.value || null)
                }
              }} className={`${inputClass} appearance-none cursor-pointer flex-1`} style={{ fontFamily: 'inherit' }}>
                <option value="">Select a key...</option>
                {providerCredentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="__add__">+ Add new key...</option>
              </select>
              <button
                type="button"
                onClick={() => { setAddingKey(true); setNewKeyName(''); setNewKeyValue('') }}
                className="shrink-0 px-3 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-600 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
              >
                + New
              </button>
            </div>
          ) : (
            <div className="space-y-3 p-4 rounded-[12px] border border-accent-bright/15 bg-accent-soft/20">
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (optional)"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <input
                type="password"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                placeholder="Paste API key..."
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <div className="flex gap-2 justify-end">
                {providerCredentials.length > 0 && (
                  <button type="button" onClick={() => setAddingKey(false)} className="px-3 py-1.5 text-[12px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none" style={{ fontFamily: 'inherit' }}>Cancel</button>
                )}
                <button
                  type="button"
                  disabled={savingKey || !newKeyValue.trim()}
                      onClick={async () => {
                        setSavingKey(true)
                        try {
                          const cred = await api<{ id: string }>('POST', '/credentials', { provider, name: newKeyName.trim() || `${provider} key`, apiKey: newKeyValue.trim() })
                          await loadCredentials()
                          setCredentialId(cred.id)
                          const synced = await syncLiveProviderModels(provider, cred.id, apiEndpoint, ollamaMode, true).catch(() => null)
                          setAddingKey(false)
                          setNewKeyName('')
                          setNewKeyValue('')
                          if (synced?.models.length) {
                            toast.success(`Key saved. Synced ${synced.models.length} model${synced.models.length === 1 ? '' : 's'}.`)
                          } else {
                            toast.success('Key saved')
                          }
                        } catch (err: unknown) { toast.error(`Failed to save: ${errorMessage(err)}`) }
                        finally { setSavingKey(false) }
                      }}
                  className="px-4 py-1.5 rounded-[8px] bg-accent-bright text-white text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40"
                  style={{ fontFamily: 'inherit' }}
                >
                  {savingKey ? 'Saving...' : 'Save Key'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fallback Credentials */}
      {!openclawEnabled && (currentProvider?.requiresApiKey || currentProvider?.optionalApiKey || (provider === 'ollama' && ollamaMode === 'cloud')) && providerCredentials.length > 1 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Fallback Keys <span className="normal-case tracking-normal font-normal text-text-3">(for auto-failover)</span>
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">If the primary key fails (rate limit, auth error), these keys will be tried in order.</p>
          <div className="flex flex-wrap gap-2">
            {providerCredentials.filter((c) => c.id !== credentialId).map((c) => {
              const active = fallbackCredentialIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => setFallbackCredentialIds((prev) => active ? prev.filter((x) => x !== c.id) : [...prev, c.id])}
                  className={`px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {currentProvider?.requiresEndpoint && (provider === 'openclaw' || (provider === 'ollama' && ollamaMode === 'local')) && (
        <div className="mb-8">
          <SectionLabel>{provider === 'openclaw' ? 'OpenClaw Endpoint' : 'Endpoint'}</SectionLabel>
          <input type="text" value={apiEndpoint || ''} onChange={(e) => setApiEndpoint(e.target.value || null)} placeholder={currentProvider.defaultEndpoint || 'http://localhost:11434'} className={`${inputClass} font-mono text-[14px]`} />
          {provider === 'openclaw' && (
            <p className="text-[13px] text-text-3/70 mt-2">The URL of your OpenClaw gateway</p>
          )}
        </div>
      )}

      </SectionCard>

      <SectionCard
        title="Instructions"
        description="Keep the agent's personality and core prompt visible and easy to edit."
      >
        <div className="mb-8">
          <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Soul / Personality <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
            <HintTip text="The agent's voice and tone — how it talks, not what it knows" />
            {soul !== soulInitial && soulSaveState === 'idle' && (
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px] text-amber-400 font-600">
                <StatusDot status="warning" size="sm" />
                Unsaved
              </span>
            )}
            {soulSaveState === 'saved' && (
              <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px] text-emerald-400 font-600">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                Saved
              </span>
            )}
          </label>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-[12px] text-text-3/60">Define the agent&apos;s voice, tone, and personality. Injected before the system prompt.</p>
            <button
              type="button"
              onClick={() => setSoul(randomSoul())}
              className="inline-flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-[8px] border border-white/[0.08] bg-transparent text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors"
              style={{ fontFamily: 'inherit' }}
              title="Randomize personality"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <circle cx="9" cy="9" r="1" fill="currentColor" />
                <circle cx="15" cy="15" r="1" fill="currentColor" />
              </svg>
              Shuffle
            </button>
            <button
              type="button"
              onClick={() => setSoulLibraryOpen(true)}
              className="shrink-0 px-2 py-1 rounded-[8px] border border-accent-bright/20 bg-accent-soft text-[11px] text-accent-bright hover:brightness-110 cursor-pointer transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              Browse Library
            </button>
            <button onClick={() => soulFileRef.current?.click()} className="shrink-0 px-2 py-1 rounded-[8px] border border-white/[0.08] bg-surface text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors" style={{ fontFamily: 'inherit' }}>Upload .md</button>
            <input ref={soulFileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload(setSoul)} className="hidden" />
          </div>
          <textarea
            value={soul}
            onChange={(e) => setSoul(e.target.value)}
            placeholder="e.g. You speak concisely and directly. You have a dry sense of humor. You always back claims with data."
            rows={3}
            className={`${inputClass} resize-y min-h-[80px]`}
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        {provider !== 'openclaw' ? (
          <div className="mb-1">
            <div className="mb-3 flex items-center gap-2">
              <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">System Prompt <HintTip text="Instructions that tell the agent what it can do, what tools to use, and how to behave" /></label>
              <button onClick={() => promptFileRef.current?.click()} className="shrink-0 px-2 py-1 rounded-[8px] border border-white/[0.08] bg-surface text-[11px] text-text-3 hover:text-text-2 cursor-pointer transition-colors" style={{ fontFamily: 'inherit' }}>Upload .md</button>
              <input ref={promptFileRef} type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload(setSystemPrompt)} className="hidden" />
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are an expert..."
              rows={6}
              className={`${inputClass} resize-y min-h-[140px]`}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        ) : (
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-4 text-[13px] leading-[1.6] text-text-3">
            OpenClaw agents rely on the gateway runtime for tool execution and node routing. Expand advanced settings if you need continuity, voice, or heartbeat overrides.
          </div>
        )}
      </SectionCard>

      {(!WORKER_ONLY_PROVIDER_IDS.has(provider) || isOrchestratorProviderEligible(provider)) && (
      <SectionCard
        title="Role & Autonomy"
        description="Define how this agent operates in the swarm."
      >
        {/* --- Role subsection --- */}
        {!WORKER_ONLY_PROVIDER_IDS.has(provider) && (
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <SectionLabel>Role</SectionLabel>
              <HintTip text="Coordinators automatically receive a list of available agents and can decompose complex goals, delegate to specialists, and synthesize results." />
            </div>
            <div className="flex gap-2 mb-3">
              {(['worker', 'coordinator'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    setRole(r)
                    if (r === 'coordinator') setDelegationEnabled(true)
                  }}
                  className={`px-4 py-1.5 rounded-[8px] text-[13px] font-display font-500 transition-all duration-200
                    ${role === r
                      ? 'bg-accent-bright text-white'
                      : 'bg-white/[0.06] text-text-3 hover:bg-white/[0.10]'}`}
                >
                  {r === 'worker' ? 'Worker' : 'Coordinator'}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-text-3/75">
              {role === 'coordinator'
                ? 'Breaks down complex goals, delegates to specialists, and synthesizes results'
                : 'Executes tasks when prompted by users or other agents'}
            </p>

            {/* Delegation toggle */}
            <div className="mt-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => {
                    if (role !== 'coordinator') setDelegationEnabled((current) => !current)
                  }}
                  className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                    ${canDelegateToAgents ? 'bg-accent-bright' : 'bg-white/[0.08]'}
                    ${role === 'coordinator' ? 'opacity-60' : ''}`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                    ${canDelegateToAgents ? 'left-[22px]' : 'left-0.5'}`} />
                </div>
                <span className="font-display text-[14px] font-600 text-text-2">Can Delegate</span>
                <span className="text-[12px] text-text-3">
                  {role === 'coordinator' ? 'Always on for coordinators' : 'Route work to specialized agents'}
                </span>
              </label>
            </div>

            {/* Delegation targets */}
            {canDelegateToAgents && agentOptions.length > 0 && (
              <div className="mt-4">
                <SectionLabel>Allowed Delegate Agents</SectionLabel>
                <AgentPickerList
                  agents={agentOptions}
                  selected={delegationTargetMode === 'all' ? [] : delegationTargetAgentIds}
                  onSelect={(id) => toggleAgent(id)}
                  noneOption={{
                    label: 'All Agents',
                    onSelect: () => {
                      setDelegationTargetMode('all')
                      setDelegationTargetAgentIds([])
                    },
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* --- Orchestrator subsection --- */}
        {isOrchestratorProviderEligible(provider) && (
          <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[14px] font-600 text-text">Orchestrator Mode</p>
                <p className="mt-1 text-[12px] leading-[1.6] text-text-3/75">
                  Wakes on a schedule to autonomously review platform state and take action.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOrchestratorEnabled((current) => !current)}
                className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${orchestratorEnabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
                aria-pressed={orchestratorEnabled}
              >
                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${orchestratorEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>

            {orchestratorEnabled && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                    Mission
                  </label>
                  <textarea
                    value={orchestratorMission}
                    onChange={(e) => setOrchestratorMission(e.target.value)}
                    placeholder="Describe the orchestrator's mission — what should it manage, optimize, or oversee?"
                    rows={3}
                    className={`${inputClass} resize-y min-h-[84px]`}
                    style={{ fontFamily: 'inherit' }}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                      Wake Interval
                    </label>
                    <input
                      type="text"
                      value={orchestratorWakeInterval}
                      onChange={(e) => setOrchestratorWakeInterval(e.target.value)}
                      placeholder="5m"
                      className={inputClass}
                      style={{ fontFamily: 'inherit' }}
                    />
                  </div>
                  <div>
                    <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                      Governance
                    </label>
                    <select
                      value={orchestratorGovernance}
                      onChange={(e) => setOrchestratorGovernance(e.target.value as typeof orchestratorGovernance)}
                      className={inputClass}
                      style={{ fontFamily: 'inherit' }}
                    >
                      <option value="autonomous">Autonomous</option>
                      <option value="approval-required">Approval Required</option>
                      <option value="notify-only">Notify Only</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
                      Max Cycles/Day
                    </label>
                    <input
                      type="number"
                      value={orchestratorMaxCyclesPerDay}
                      onChange={(e) => setOrchestratorMaxCyclesPerDay(e.target.value)}
                      placeholder="No limit"
                      min={1}
                      className={inputClass}
                      style={{ fontFamily: 'inherit' }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>
      )}

      {!WORKER_ONLY_PROVIDER_IDS.has(provider) && (
      <SectionCard
        title="Behavior"
        description="Keep the core autonomy switch visible. Expert heartbeat controls stay in advanced settings."
      >
        <div className="flex items-center justify-between gap-4 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-4">
          <div className="min-w-0">
            <p className="text-[14px] font-600 text-text">Heartbeat</p>
            <p className="mt-1 text-[12px] leading-[1.6] text-text-3/75">
              Keep this agent alive in the background for proactive work and scheduled follow-through.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setHeartbeatEnabled((current) => !current)}
            className={`relative h-6 w-11 shrink-0 rounded-full border-none transition-colors duration-200 ${heartbeatEnabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
            aria-pressed={heartbeatEnabled}
          >
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ${heartbeatEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      </SectionCard>
      )}

      {!WORKER_ONLY_PROVIDER_IDS.has(provider) && (
      <AdvancedSettingsSection
        open={showAdvancedSettings}
        onToggle={() => setShowAdvancedSettings((current) => !current)}
        summary={advancedSummary}
        badges={agentAdvancedBadges}
      >
      <SectionCard
        title="Voice & Autonomy"
        description="Tune voice and the detailed heartbeat behavior for this agent."
        className="mb-6 border-white/[0.05] bg-white/[0.01]"
      >
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Voice &amp; Audio
        </label>
        {voiceControlsAvailable ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3">
              <input
                type="text"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                placeholder="ElevenLabs voice ID"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <button
                type="button"
                onClick={() => setVoiceId('')}
                className="px-3 py-2.5 rounded-[10px] border border-white/[0.08] bg-transparent text-[12px] font-600 text-text-3 hover:bg-white/[0.04] hover:text-text-2 transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                Use global default
              </button>
            </div>
            <p className="mt-2 text-[12px] leading-[1.6] text-text-3/70">
              Current effective voice: <span className="text-text-2">{effectiveVoiceId}</span> · {effectiveVoiceSource}
              {!voicePlaybackEnabled && ' · Voice playback is disabled globally'}
            </p>
          </>
        ) : (
          <p className="text-[12px] leading-[1.6] text-text-3/70">
            ElevenLabs is not configured yet. Add a global API key in Settings to enable voice overrides here.
          </p>
        )}
      </div>

      <div>
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Heartbeat Controls
        </label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <select
            value={heartbeatIntervalSec}
            onChange={(e) => setHeartbeatIntervalSec(e.target.value)}
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">Use default interval</option>
            {HB_PRESETS.map((preset) => (
              <option key={preset} value={preset}>{formatHbDuration(preset)}</option>
            ))}
          </select>
          <input
            type="text"
            value={heartbeatModel}
            onChange={(e) => setHeartbeatModel(e.target.value)}
            placeholder="Heartbeat model override"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
        <textarea
          value={heartbeatPrompt}
          onChange={(e) => setHeartbeatPrompt(e.target.value)}
          placeholder="Optional custom heartbeat prompt"
          rows={3}
          className={`${inputClass} resize-y min-h-[84px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>
      </SectionCard>

      <SectionCard
        title="Memory & Intelligence"
        description="Reasoning depth, memory defaults, and drafting behavior."
        className="mb-6 border-white/[0.05] bg-white/[0.01]"
      >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value as typeof thinkingLevel)} className={inputClass}>
          <option value="">Default thinking</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <select value={memoryScopeMode} onChange={(e) => setMemoryScopeMode(e.target.value as typeof memoryScopeMode)} className={inputClass}>
          <option value="auto">Auto memory scope</option>
          <option value="all">All</option>
          <option value="global">Global</option>
          <option value="agent">Agent</option>
          <option value="session">Session</option>
          <option value="project">Project</option>
        </select>
        <select value={memoryTierPreference} onChange={(e) => setMemoryTierPreference(e.target.value as typeof memoryTierPreference)} className={inputClass}>
          <option value="blended">Blended tiering</option>
          <option value="working">Working memory</option>
          <option value="durable">Durable memory</option>
          <option value="archive">Archive memory</option>
        </select>
      </div>
      <div className="space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => setProactiveMemory((current) => !current)}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${proactiveMemory ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${proactiveMemory ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Use proactive recall before each run</span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => setAutoDraftSkillSuggestions((current) => !current)}
            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${autoDraftSkillSuggestions ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${autoDraftSkillSuggestions ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Auto-draft conversation skills</span>
        </label>
      </div>
      </SectionCard>

      <SectionCard
        title="Continuity"
        description="Stable identity, relationship context, and session reset policy."
        className="mb-6 border-white/[0.05] bg-white/[0.01]"
      >
      <div className="mb-8">
        <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Identity Continuity <HintTip text="Seeds the agent's continuity state so session memory can preserve a stable persona and relationship context." />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <input type="text" value={identityPersonaLabel} onChange={(e) => setIdentityPersonaLabel(e.target.value)} placeholder="Persona label" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={identityToneStyle} onChange={(e) => setIdentityToneStyle(e.target.value)} placeholder="Tone style" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
        <div className="grid grid-cols-1 gap-3">
          <textarea value={identitySelfSummary} onChange={(e) => setIdentitySelfSummary(e.target.value)} placeholder="How this agent should summarize itself across sessions." rows={3} className={`${inputClass} resize-y min-h-[84px]`} style={{ fontFamily: 'inherit' }} />
          <textarea value={identityRelationshipSummary} onChange={(e) => setIdentityRelationshipSummary(e.target.value)} placeholder="Relationship framing or standing context the agent should keep in mind." rows={3} className={`${inputClass} resize-y min-h-[84px]`} style={{ fontFamily: 'inherit' }} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <textarea value={identityBoundariesText} onChange={(e) => setIdentityBoundariesText(e.target.value)} placeholder="Boundaries, one per line." rows={4} className={`${inputClass} resize-y min-h-[108px]`} style={{ fontFamily: 'inherit' }} />
            <textarea value={identityContinuityNotesText} onChange={(e) => setIdentityContinuityNotesText(e.target.value)} placeholder="Continuity notes, one per line." rows={4} className={`${inputClass} resize-y min-h-[108px]`} style={{ fontFamily: 'inherit' }} />
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-[1.5] text-text-3/60">
          Use one line per item. Boundaries are stable guardrails; continuity notes are recurring relationship or project context worth carrying across sessions.
        </p>
      </div>

      <div>
        <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Session Reset Policy <HintTip text="Controls when this agent's sessions are considered stale and should be refreshed." />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <select value={sessionResetMode} onChange={(e) => setSessionResetMode(e.target.value as typeof sessionResetMode)} className={inputClass} style={{ fontFamily: 'inherit' }}>
            <option value="">Inherit global default</option>
            <option value="idle">Idle</option>
            <option value="daily">Daily</option>
            <option value="isolated">Isolated (fresh context per run)</option>
          </select>
          <input type="number" min={0} value={sessionIdleTimeoutSec} onChange={(e) => setSessionIdleTimeoutSec(e.target.value)} placeholder="Idle timeout in seconds" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input type="number" min={0} value={sessionMaxAgeSec} onChange={(e) => setSessionMaxAgeSec(e.target.value)} placeholder="Max age in seconds" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={sessionDailyResetAt} onChange={(e) => setSessionDailyResetAt(e.target.value)} placeholder="Daily reset time (HH:MM)" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="text" value={sessionResetTimezone} onChange={(e) => setSessionResetTimezone(e.target.value)} placeholder="Timezone (optional)" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
      </div>
      </SectionCard>

      <SectionCard
        title="Routing & Infrastructure"
        description="Project binding, filesystem access, and other deeper runtime controls."
        className="mb-6 border-white/[0.05] bg-white/[0.01]"
      >
      {Object.keys(projects).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Project</label>
          <select value={projectId || ''} onChange={(e) => setProjectId(e.target.value || undefined)} className={inputClass} style={{ fontFamily: 'inherit' }}>
            <option value="">No project</option>
            {Object.values(projects).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
      )}
      {openclawEnabled && (
        <div className="mb-8">
          <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Gateway Preferences <HintTip text="When multiple OpenClaw gateways are available, prefer matching tags or deployment templates before falling back to the default route." />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              value={preferredGatewayTagsText}
              onChange={(e) => setPreferredGatewayTagsText(e.target.value)}
              placeholder="gpu, local, research"
              className={inputClass}
            />
            <select value={preferredGatewayUseCase} onChange={(e) => setPreferredGatewayUseCase(e.target.value)} className={inputClass}>
              <option value="">Any OpenClaw template</option>
              <option value="local-dev">Local Dev</option>
              <option value="single-vps">Single VPS</option>
              <option value="private-tailnet">Private Tailnet</option>
              <option value="browser-heavy">Browser Heavy</option>
              <option value="team-control">Team Control</option>
            </select>
          </div>
          <p className="text-[11px] text-text-3/70 mt-2">
            These preferences bias scheduling toward matching OpenClaw control planes without hard-locking the agent to one gateway.
          </p>
        </div>
      )}
      <div className="mb-8">
        <label className="flex items-center gap-2 font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Model Routing <HintTip text="Route this agent through a provider/model pool instead of a single fixed model. The base provider remains the default when no route matches." />
        </label>
        <div className="flex items-center gap-3 mb-3">
          <select value={routingStrategy} onChange={(e) => setRoutingStrategy(e.target.value as AgentRoutingStrategy)} className={inputClass}>
            <option value="single">Single route</option>
            <option value="balanced">Balanced</option>
            <option value="economy">Economy</option>
            <option value="premium">Premium</option>
            <option value="reasoning">Reasoning</option>
          </select>
          <button
            type="button"
            onClick={addRoutingTargetFromCurrent}
            className="shrink-0 px-3 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-700 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
          >
            + Add Current Route
          </button>
        </div>
        <div className="space-y-3">
          {routingTargets.map((target, index) => {
            const targetCredentials = resolveAgentSelectableProviderCredentials(target.provider, credentials, providerConfigs)
            return (
              <div key={target.id} className="p-4 rounded-[12px] border border-white/[0.08] bg-white/[0.02] space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    value={target.label || ''}
                    onChange={(e) => updateRoutingTarget(target.id, { label: e.target.value })}
                    placeholder={`Route ${index + 1} label`}
                    className={inputClass}
                  />
                  <select value={target.role || 'backup'} onChange={(e) => updateRoutingTarget(target.id, { role: e.target.value as AgentRoutingTarget['role'] })} className={inputClass}>
                    <option value="primary">Primary</option>
                    <option value="economy">Economy</option>
                    <option value="premium">Premium</option>
                    <option value="reasoning">Reasoning</option>
                    <option value="backup">Backup</option>
                  </select>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <select
                    value={target.provider}
                    onChange={(e) => {
                      const nextProviderId = e.target.value
                      const nextCredentials = resolveAgentSelectableProviderCredentials(nextProviderId, credentials, providerConfigs)
                      updateRoutingTarget(target.id, {
                        provider: nextProviderId,
                        credentialId: nextCredentials[0]?.id || null,
                        gatewayProfileId: nextProviderId === 'openclaw' ? target.gatewayProfileId : null,
                        ollamaMode: nextProviderId === 'ollama'
                        ? resolveStoredOllamaMode({
                          ollamaMode: target.ollamaMode ?? null,
                          apiEndpoint: target.apiEndpoint ?? null,
                        })
                        : null,
                      })
                    }}
                    className={inputClass}
                  >
                    {agentSelectableProviders.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                  <input
                    value={target.model}
                    onChange={(e) => updateRoutingTarget(target.id, { model: e.target.value })}
                    placeholder="Model"
                    className={inputClass}
                  />
                </div>
                {target.provider === 'openclaw' && openclawGatewayProfiles.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <select
                      value={target.gatewayProfileId || ''}
                      onChange={(e) => {
                        const nextId = e.target.value || null
                        const gateway = openclawGatewayProfiles.find((item) => item.id === nextId)
                        updateRoutingTarget(target.id, {
                          gatewayProfileId: nextId,
                          apiEndpoint: gateway?.endpoint || target.apiEndpoint || null,
                          credentialId: gateway?.credentialId || target.credentialId || null,
                          model: target.model || 'default',
                        })
                      }}
                      className={inputClass}
                    >
                      <option value="">Custom OpenClaw endpoint</option>
                      {openclawGatewayProfiles.map((gateway) => (
                        <option key={gateway.id} value={gateway.id}>{gateway.name}</option>
                      ))}
                    </select>
                    <input
                      value={formatGatewayTagList(target.preferredGatewayTags)}
                      onChange={(e) => updateRoutingTarget(target.id, { preferredGatewayTags: parseGatewayTagList(e.target.value) })}
                      placeholder="Prefer tags"
                      className={inputClass}
                    />
                    <select
                      value={target.preferredGatewayUseCase || ''}
                      onChange={(e) => updateRoutingTarget(target.id, { preferredGatewayUseCase: e.target.value || null })}
                      className={inputClass}
                    >
                      <option value="">Any OpenClaw template</option>
                      <option value="local-dev">Local Dev</option>
                      <option value="single-vps">Single VPS</option>
                      <option value="private-tailnet">Private Tailnet</option>
                      <option value="browser-heavy">Browser Heavy</option>
                      <option value="team-control">Team Control</option>
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
                  <input
                    value={target.apiEndpoint || ''}
                    onChange={(e) => updateRoutingTarget(target.id, { apiEndpoint: e.target.value || null })}
                    placeholder="Endpoint (optional)"
                    className={`${inputClass} font-mono text-[14px]`}
                  />
                  <select value={target.credentialId || ''} onChange={(e) => updateRoutingTarget(target.id, { credentialId: e.target.value || null })} className={inputClass}>
                    <option value="">No key</option>
                    {targetCredentials.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex justify-end">
                  <button type="button" onClick={() => removeRoutingTarget(target.id)} className="px-3 py-1.5 rounded-[8px] border border-red-400/20 bg-red-400/[0.06] text-[12px] font-700 text-red-300 hover:bg-red-400/[0.1] transition-all cursor-pointer">
                    Remove Route
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        {routingTargets.length === 0 && (
          <p className="text-[11px] text-text-3/70 mt-2">No route pool yet. Add one if this agent should switch between cheaper, stronger, or gateway-specific models.</p>
        )}
      </div>
      <div>
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Filesystem Access</label>
        <select
          value={filesystemScope}
          onChange={(e) => setFilesystemScope(e.target.value as 'workspace' | 'machine')}
          className="w-full h-10 px-3 rounded-[10px] bg-white/[0.04] border border-white/[0.06] text-[14px] text-text-2"
        >
          <option value="workspace">Workspace only</option>
          <option value="machine">Full machine</option>
        </select>
        {filesystemScope === 'machine' && (
          <p className="mt-2 text-[12px] text-amber-400/80">Agent can access any file your user account can reach. Sensitive paths (.ssh, .env, .gnupg) are blocked by default.</p>
        )}
      </div>
      </SectionCard>

      <SectionCard
        title="Safety & Limits"
        description="Enable safeguards, recovery, and spend limits without crowding the main setup flow."
        className="mb-6 border-white/[0.05] bg-white/[0.01]"
      >
      <div className="space-y-3 mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <div onClick={() => setDisabled((current) => !current)} className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${disabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${disabled ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Disable this agent</span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <div onClick={() => setAutoRecovery((current) => !current)} className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${autoRecovery ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${autoRecovery ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Guardian auto-recovery</span>
        </label>
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <div onClick={() => setBudgetEnabled((current) => !current)} className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0 ${budgetEnabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200 ${budgetEnabled ? 'left-[22px]' : 'left-0.5'}`} />
          </div>
          <span className="text-[13px] text-text-2">Spend limits</span>
        </label>
      </div>
      {budgetEnabled && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input type="number" min={0} step="0.01" value={hourlyBudget} onChange={(e) => setHourlyBudget(e.target.value)} placeholder="Hourly" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="number" min={0} step="0.01" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} placeholder="Daily" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <input type="number" min={0} step="0.01" value={monthlyBudget} onChange={(e) => setMonthlyBudget(e.target.value)} placeholder="Monthly" className={inputClass} style={{ fontFamily: 'inherit' }} />
          <select value={budgetAction} onChange={(e) => setBudgetAction(e.target.value as typeof budgetAction)} className={inputClass} style={{ fontFamily: 'inherit' }}>
            <option value="warn">Warn</option>
            <option value="block">Block</option>
          </select>
        </div>
      )}
      </SectionCard>

      <SectionCard
        title="Tools & Skills"
        description="Enable tool families, pin preferred skills, and connect MCP tools for this agent."
        className="mb-6 border-white/[0.05] bg-white/[0.01]"
      >
      {/* Tools — hidden for providers that manage capabilities outside LangGraph */}
      {!hasNativeCapabilities && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Tools</label>
          <p className="text-[12px] text-text-3/60 mb-3">Enable built-in tool families for this agent.</p>
          <div className="space-y-3">
            {AVAILABLE_TOOLS
              .map((t) => {
                const extensionDisabled = !!t.extensionId && !!enabledExtensionIds && !enabledExtensionIds.has(t.extensionId)
                return (
                  <label key={t.id} className={`flex items-center gap-3 ${extensionDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`} title={extensionDisabled ? 'Enable in Extensions page' : undefined}>
                    <div
                      onClick={() => !extensionDisabled && setTools((prev) => prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id])}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative shrink-0
                        ${extensionDisabled ? 'bg-white/[0.04] cursor-not-allowed' : tools.includes(t.id) ? 'bg-accent-bright cursor-pointer' : 'bg-white/[0.08] cursor-pointer'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                        ${tools.includes(t.id) && !extensionDisabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className={`font-display text-[14px] font-600 ${extensionDisabled ? 'text-text-3/40' : 'text-text-2'}`}>{t.label}</span>
                    <span className={`text-[12px] ${extensionDisabled ? 'text-text-3/30' : 'text-text-3'}`}>
                      {extensionDisabled ? 'Enable in Extensions page' : t.description}
                    </span>
                  </label>
                )
              })}
          </div>
        </div>
      )}

      {/* Filesystem Access */}
      <div className="mb-8">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Filesystem Access</label>
        <select
          value={filesystemScope}
          onChange={(e) => setFilesystemScope(e.target.value as 'workspace' | 'machine')}
          className="w-full h-10 px-3 rounded-[10px] bg-white/[0.04] border border-white/[0.06] text-[14px] text-text-2"
        >
          <option value="workspace">Workspace only</option>
          <option value="machine">Full machine</option>
        </select>
        {filesystemScope === 'machine' && (
          <p className="mt-2 text-[12px] text-amber-400/80">Agent can access any file your user account can reach. Sensitive paths (.ssh, .env, .gnupg) are blocked by default.</p>
        )}
      </div>

      {/* Platform — hidden for providers that manage capabilities outside LangGraph */}
      {!hasNativeCapabilities && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Platform Tools</label>
          <p className="text-[12px] text-text-3/60 mb-3">Allow this agent to manage platform resources directly.</p>
          <div className="space-y-3">
            {PLATFORM_TOOLS
              .map((t) => {
                const extensionDisabled = !!t.extensionId && !!enabledExtensionIds && !enabledExtensionIds.has(t.extensionId)
                return (
                  <label key={t.id} className={`flex items-center gap-3 ${extensionDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`} title={extensionDisabled ? 'Enable in Extensions page' : undefined}>
                    <div
                      onClick={() => !extensionDisabled && setTools((prev) => prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id])}
                      className={`w-11 h-6 rounded-full transition-all duration-200 relative shrink-0
                        ${extensionDisabled ? 'bg-white/[0.04] cursor-not-allowed' : tools.includes(t.id) ? 'bg-accent-bright cursor-pointer' : 'bg-white/[0.08] cursor-pointer'}`}
                    >
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                        ${tools.includes(t.id) && !extensionDisabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </div>
                    <span className={`font-display text-[14px] font-600 ${extensionDisabled ? 'text-text-3/40' : 'text-text-2'}`}>{t.label}</span>
                    <span className={`text-[12px] ${extensionDisabled ? 'text-text-3/30' : 'text-text-3'}`}>
                      {extensionDisabled ? 'Enable in Extensions page' : t.description}
                    </span>
                  </label>
                )
              })}
          </div>
        </div>
      )}

      {/* Native capability provider note — not shown for OpenClaw (covered in connection status) */}
      {hasNativeCapabilities && !openclawEnabled && (
        <div className="mb-8 p-4 rounded-[14px] bg-white/[0.02] border border-white/[0.06]">
          <p className="text-[13px] text-text-3">
            {provider === 'claude-cli'
              ? 'Claude CLI uses its own built-in capabilities — no additional local tool/platform configuration is needed.'
              : provider === 'codex-cli'
                ? 'OpenAI Codex CLI uses its own built-in tools (shell, files, etc.) — no additional local tool configuration needed.'
                : 'OpenCode CLI uses its own built-in tools (shell, files, etc.) — no additional local tool configuration needed.'}
          </p>
        </div>
      )}

      {/* Skills — discovered from ~/.claude/skills/ */}
      {provider === 'claude-cli' && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">
              Pinned Claude Skills <span className="normal-case tracking-normal font-normal text-text-3">(from ~/.claude/skills/)</span>
            </label>
            <button
              onClick={loadClaudeSkills}
              disabled={claudeSkillsLoading}
              className="text-[11px] text-text-3 hover:text-accent-bright transition-colors cursor-pointer bg-transparent border-none flex items-center gap-1"
              style={{ fontFamily: 'inherit' }}
              title="Refresh skills from ~/.claude/skills/"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={claudeSkillsLoading ? 'animate-spin' : ''}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              Refresh
            </button>
          </div>
          <p className="text-[12px] text-text-3/60 mb-3">Optional preference list. Pinned Claude skills are called out explicitly when this agent is delegated work.</p>
          {claudeSkills.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {claudeSkills.map((s) => {
                const active = skills.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() => setSkills((prev) => active ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                    className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                      ${active
                        ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                        : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                    style={{ fontFamily: 'inherit' }}
                    title={s.description}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-[12px] text-text-3/70">No skills found in ~/.claude/skills/</p>
          )}
        </div>
      )}

      {/* Dynamic Skills from Skills Manager */}
      {Object.keys(dynamicSkills).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Pinned Skills <span className="normal-case tracking-normal font-normal text-text-3">(from Skills manager)</span>
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">All ready local skills are discoverable by default. Pin skills here only when they should stay in this agent&apos;s prompt as always-on guidance.</p>
          <div className="flex flex-wrap gap-2">
            {Object.values(dynamicSkills).map((s) => {
              const active = skillIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => setSkillIds((prev) => active ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                  className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                  title={s.description || s.filename}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {Object.keys(mcpServers).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            MCP Servers
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">Connect external tool servers to this agent via MCP.</p>
          <div className="flex flex-wrap gap-2">
            {Object.values(mcpServers).map((s) => {
              const active = mcpServerIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => setMcpServerIds((prev) => active ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                  className={`px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                    ${active
                      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                      : 'bg-surface border-white/[0.06] text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                  title={`${s.transport} — ${s.command || s.url || ''}`}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* MCP Tools — per-tool enable/disable toggles */}
      {mcpServerIds.length > 0 && Object.keys(mcpTools).length > 0 && (
        <div className="mb-8">
          <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            MCP Tools
          </label>
          <p className="text-[12px] text-text-3/60 mb-3">
            Toggle individual tools from connected MCP servers.{mcpToolsLoading ? ' Loading…' : ''}
          </p>
          <div className="space-y-4">
            {mcpServerIds.map((serverId) => {
              const server = mcpServers[serverId]
              const serverTools = mcpTools[serverId]
              if (!server || !serverTools?.length) return null
              const safeName = server.name.replace(/[^a-zA-Z0-9_]/g, '_')
              return (
                <div key={serverId}>
                  <p className="text-[12px] font-600 text-text-3 mb-2">{server.name}</p>
                  <div className="space-y-3">
                    {serverTools.map((t) => {
                      const fullName = `mcp_${safeName}_${t.name}`
                      const enabled = !mcpDisabledTools.includes(fullName)
                      return (
                        <label key={fullName} className="flex items-center gap-3 cursor-pointer">
                          <div
                            onClick={() => setMcpDisabledTools((prev) =>
                              enabled ? [...prev, fullName] : prev.filter((x) => x !== fullName)
                            )}
                            className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                              ${enabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                          >
                            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                              ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                          </div>
                          <span className="font-display text-[14px] font-600 text-text-2">{t.name}</span>
                          <span className="text-[12px] text-text-3 truncate">{t.description}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="mb-2">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">Capabilities</label>
        <p className="text-[12px] text-text-3/60 mb-3">Optional tags that describe what this agent is especially good at.</p>
        {capabilities.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {capabilities.map((capability) => (
              <span key={capability} className="inline-flex items-center gap-1.5 rounded-[8px] border border-accent-bright/20 bg-accent-soft/20 px-3 py-1 text-[12px] text-accent-bright">
                {capability}
                <button
                  type="button"
                  onClick={() => setCapabilities((current) => current.filter((entry) => entry !== capability))}
                  className="bg-transparent border-none text-accent-bright/70 hover:text-accent-bright cursor-pointer"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              const next = capInput.trim()
              if (!next || capabilities.includes(next)) return
              setCapabilities((current) => [...current, next])
              setCapInput('')
            }}
            placeholder="Add a capability tag"
            className={inputClass}
            style={{ fontFamily: 'inherit' }}
          />
          <button
            type="button"
            onClick={() => {
              const next = capInput.trim()
              if (!next || capabilities.includes(next)) return
              setCapabilities((current) => [...current, next])
              setCapInput('')
            }}
            className="shrink-0 px-3 py-2.5 rounded-[10px] bg-accent-soft/50 text-accent-bright text-[12px] font-700 hover:bg-accent-soft transition-colors cursor-pointer border border-accent-bright/20"
          >
            Add
          </button>
        </div>
      </div>
      </SectionCard>

      <SectionCard
        title="Utilities"
        description="Import and export agents, and manage any attached wallets."
        className="mb-0 border-white/[0.05] bg-white/[0.01]"
      >
      <div className="flex flex-wrap gap-3">
        {editing ? (
          <button
            type="button"
            onClick={handleExport}
            className="px-4 py-2.5 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 cursor-pointer hover:bg-white/[0.04] transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Export agent
          </button>
        ) : (
          <button
            type="button"
            onClick={() => importFileRef.current?.click()}
            className="px-4 py-2.5 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[12px] font-600 cursor-pointer hover:bg-white/[0.04] transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            Import agent
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-6">
          <WalletSection
            agentId={editing.id}
            wallets={agentWallets}
            activeWalletId={editing.activeWalletId || null}
            onWalletCreated={() => loadAgentWallets(editing.id)}
          />
        </div>
      )}
      </SectionCard>
      </AdvancedSettingsSection>
      )}

      {/* Provider key warning */}
      {providerNeedsKey && (
        <div className="mb-4 p-3 rounded-[12px] bg-amber-500/[0.08] border border-amber-500/20">
          <p className="text-[13px] text-amber-400">
            Add an API key for {currentProvider?.name || provider} above before creating this agent.
          </p>
        </div>
      )}

      {/* Test connection result (hidden for OpenClaw — inline status block handles it) */}
      {!openclawEnabled && testStatus === 'fail' && (
        <div className="mb-4 p-3 rounded-[12px] bg-red-500/[0.08] border border-red-500/20">
          <p className="text-[13px] text-red-400">{testMessage || 'Connection test failed'}</p>
        </div>
      )}
      {!openclawEnabled && testStatus === 'pass' && (
        <div className="mb-4 p-3 rounded-[12px] bg-emerald-500/[0.08] border border-emerald-500/20">
          <p className="text-[13px] text-emerald-400">{testMessage || 'Connected successfully'}</p>
        </div>
      )}

      {/* Import file input (hidden) */}
      <input ref={importFileRef} type="file" accept=".json" onChange={handleImport} className="hidden" />

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button
          onClick={handleTestAndSave}
          disabled={!name.trim() || providerNeedsKey || testStatus === 'testing' || saving || (!openclawEnabled && testStatus === 'pass')}
          className={`flex-1 py-3.5 rounded-[14px] border-none text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-60 transition-all hover:brightness-110
            ${testStatus === 'pass' ? 'bg-emerald-600 shadow-[0_4px_20px_rgba(16,185,129,0.25)]' : 'bg-accent-bright shadow-[0_4px_20px_rgba(99,102,241,0.25)]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          {openclawEnabled
            ? (testStatus === 'testing' ? 'Connecting...'
              : testStatus === 'pass' ? (saving ? 'Saving...' : 'Save')
              : testStatus === 'fail' && testErrorCode === 'PAIRING_REQUIRED' ? 'Retry Connection'
              : testStatus === 'fail' ? 'Retry'
              : 'Connect')
            : (testStatus === 'testing' ? 'Testing...' : testStatus === 'pass' ? (saving ? 'Saving...' : 'Connected!') : needsTest ? 'Test & Save' : editing ? 'Save' : 'Create')}
        </button>
      </div>
    </BottomSheet>

    <SoulLibraryPicker
      open={soulLibraryOpen}
      onClose={() => setSoulLibraryOpen(false)}
      onSelect={(s) => setSoul(s)}
    />
    </>
  )
}
