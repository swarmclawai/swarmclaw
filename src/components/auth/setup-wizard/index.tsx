'use client'

import { useMemo, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { dedup, errorMessage } from '@/lib/shared-utils'
import type { ProviderType, GatewayProfile } from '@/types'
import {
  SETUP_PROVIDERS,
  SWARMCLAW_ASSISTANT_PROMPT,
  getDefaultModelForProvider,
  type SetupProvider,
} from '@/lib/setup-defaults'
import { getDefaultAgentPluginIds } from '@/lib/agent-default-tools'
import type {
  SetupStep,
  SetupWizardProps,
  ConfiguredProvider,
  StarterDraftAgent,
  CreatedAgentSummary,
  ProviderCheckResponse,
} from './types'
import { STEP_ORDER } from './types'
import { stepIndex } from './utils'
import { SparkleIcon } from './shared'
import { StepProgress } from './step-progress'
import { StepProviders } from './step-providers'
import { StepConnect } from './step-connect'
import { StepAgents } from './step-agents'
import { StepNext } from './step-next'
import { StepProfile } from './step-profile'

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const setUser = useAppStore((s) => s.setUser)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [step, setStep] = useState<SetupStep>('profile')

  const [activeProvider, setActiveProvider] = useState<SetupProvider | null>(null)
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [activeProviderLabel, setActiveProviderLabel] = useState('')

  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])
  const [draftAgents, setDraftAgents] = useState<StarterDraftAgent[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedProvider = useMemo(
    () => SETUP_PROVIDERS.find((candidate) => candidate.id === activeProvider) || null,
    [activeProvider],
  )
  const editingProvider = useMemo(
    () => editingProviderId ? configuredProviders.find((cp) => cp.id === editingProviderId) || null : null,
    [editingProviderId, configuredProviders],
  )
  const totalSteps = STEP_ORDER.length
  const configuredProviderIds = new Set(configuredProviders.map((cp) => cp.provider))
  const canContinueFromProviders = configuredProviders.length > 0

  const skip = async () => {
    try {
      await api('PUT', '/settings', { setupCompleted: true })
    } catch {
      // Continue anyway.
    }
    onComplete()
  }

  const handleProfileContinue = async (userName: string, avatarSeed: string) => {
    try {
      await api('PUT', '/settings', { userName, userAvatarSeed: avatarSeed })
    } catch { /* still set locally */ }
    setUser(userName)
    loadSettings()
    setStep('providers')
  }

  const selectProvider = (nextProvider: SetupProvider) => {
    const meta = SETUP_PROVIDERS.find((candidate) => candidate.id === nextProvider)
    const existing = configuredProviders.find((cp) => cp.provider === nextProvider)
    setActiveProvider(nextProvider)
    setEditingProviderId(existing?.id || null)
    setActiveProviderLabel(existing?.name || meta?.name || '')
    setError('')
    setStep('connect')
  }

  const removeProvider = (id: string) => {
    const nextConfigured = configuredProviders.filter((cp) => cp.id !== id)
    setConfiguredProviders(nextConfigured)
    // Remove agents that were using this provider, or clear their provider assignment
    setDraftAgents((current) => current.map((draft) => {
      if (draft.providerConfigId !== id) return draft
      const fallback = nextConfigured[0] || null
      return {
        ...draft,
        providerConfigId: fallback?.id || null,
        provider: fallback?.provider || null,
        credentialId: fallback?.credentialId || null,
        apiEndpoint: fallback?.endpoint || null,
        gatewayProfileId: fallback?.gatewayProfileId || null,
        model: fallback?.defaultModel || draft.model,
      }
    }))
  }

  const handleSaveProvider = (configured: ConfiguredProvider) => {
    let nextConfigured: ConfiguredProvider[]
    if (editingProviderId) {
      nextConfigured = configuredProviders.map((cp) =>
        cp.id === editingProviderId ? { ...configured, id: editingProviderId } : cp,
      )
    } else {
      nextConfigured = [...configuredProviders, configured]
    }
    setConfiguredProviders(nextConfigured)

    // If this is the first provider and there are no agents yet, create a default agent
    if (!editingProviderId && draftAgents.length === 0) {
      const cp = configured
      setDraftAgents([{
        id: `auto:${crypto.randomUUID().slice(0, 8)}`,
        templateId: 'auto',
        name: 'Assistant',
        description: 'A helpful assistant.',
        systemPrompt: SWARMCLAW_ASSISTANT_PROMPT,
        soul: '',
        providerConfigId: cp.id,
        provider: cp.provider,
        model: cp.defaultModel,
        credentialId: cp.credentialId,
        apiEndpoint: cp.endpoint,
        gatewayProfileId: cp.gatewayProfileId,
        tools: getDefaultAgentPluginIds(),
        capabilities: [],
        platformAssignScope: 'self',
        avatarSeed: crypto.randomUUID().slice(0, 8),
        avatarUrl: null,
        enabled: true,
      }])
    } else {
      // Update existing agents that reference the edited provider
      if (editingProviderId) {
        setDraftAgents((current) => current.map((draft) => {
          if (draft.providerConfigId !== editingProviderId) return draft
          return {
            ...draft,
            provider: configured.provider,
            credentialId: configured.credentialId,
            apiEndpoint: configured.endpoint,
            gatewayProfileId: configured.gatewayProfileId,
            model: draft.model || configured.defaultModel,
          }
        }))
      }
    }

    setActiveProvider(null)
    setEditingProviderId(null)
    setError('')
    setStep('agents')
  }

  const handleBackFromConnect = () => {
    setActiveProvider(null)
    setEditingProviderId(null)
    setStep('providers')
  }

  const goToAgentReview = () => {
    setError('')
    setStep('agents')
  }

  const addBlankAgent = () => {
    const defaultProvider = configuredProviders[0] || null
    const newAgent: StarterDraftAgent = {
      id: `custom:${crypto.randomUUID().slice(0, 8)}`,
      templateId: 'custom',
      name: `Agent ${draftAgents.length + 1}`,
      description: '',
      systemPrompt: '',
      soul: '',
      providerConfigId: defaultProvider?.id || null,
      provider: defaultProvider?.provider || null,
      model: defaultProvider?.defaultModel || '',
      credentialId: defaultProvider?.credentialId || null,
      apiEndpoint: defaultProvider?.endpoint || null,
      gatewayProfileId: defaultProvider?.gatewayProfileId || null,
      tools: getDefaultAgentPluginIds(),
      capabilities: [],
      platformAssignScope: 'self',
      avatarSeed: crypto.randomUUID().slice(0, 8),
      avatarUrl: null,
      enabled: true,
    }
    setDraftAgents((current) => [...current, newAgent])
  }

  const removeAgent = (id: string) => {
    setDraftAgents((current) => current.filter((draft) => draft.id !== id))
  }

  const updateDraftAgent = (id: string, patch: Partial<StarterDraftAgent>) => {
    setDraftAgents((current) => current.map((draft) => (
      draft.id === id
        ? { ...draft, ...patch }
        : draft
    )))
  }

  const updateDraftAgentProvider = (id: string, nextProviderConfigId: string) => {
    const configuredProvider = configuredProviders.find((candidate) => candidate.id === nextProviderConfigId)
    if (!configuredProvider) return

    setDraftAgents((current) => current.map((draft) => {
      if (draft.id !== id) return draft
      const previousDefault = draft.provider ? getDefaultModelForProvider(draft.provider) : ''
      const nextModel = !draft.model || draft.model === previousDefault
        ? configuredProvider.defaultModel
        : draft.model
      return {
        ...draft,
        providerConfigId: configuredProvider.id,
        provider: configuredProvider.provider,
        credentialId: configuredProvider.credentialId,
        apiEndpoint: configuredProvider.endpoint,
        gatewayProfileId: configuredProvider.gatewayProfileId,
        model: nextModel,
      }
    }))
  }

  const createAgentsAndFinish = async () => {
    const enabledDrafts = draftAgents.filter((draft) => draft.enabled)
    if (enabledDrafts.some((draft) => !draft.provider)) {
      setError('Every enabled agent needs a provider assignment before you continue.')
      return
    }

    setSaving(true)
    setError('')
    try {
      // Validate each enabled agent's model against its provider before saving
      const checkedCombos = new Map<string, ProviderCheckResponse>()
      for (const draft of enabledDrafts) {
        const cp = configuredProviders.find((c) => c.id === draft.providerConfigId)
        if (!cp || cp.provider === 'openclaw') continue
        const comboKey = `${cp.provider}|${draft.apiEndpoint || cp.endpoint || ''}|${draft.model}`
        if (checkedCombos.has(comboKey)) continue
        try {
          const result = await api<ProviderCheckResponse>('POST', '/setup/check-provider', {
            provider: cp.provider,
            credentialId: cp.credentialId || undefined,
            endpoint: draft.apiEndpoint || cp.endpoint || undefined,
            model: draft.model || undefined,
          })
          checkedCombos.set(comboKey, result)
          if (!result.ok) {
            setError(`${draft.name}: ${result.message}`)
            return
          }
        } catch (err: unknown) {
          setError(`${draft.name}: Could not verify provider — ${errorMessage(err)}`)
          return
        }
      }

      const gatewayProfileIdsByProviderConfig = new Map<string, string>()
      const openClawProviders = configuredProviders.filter((candidate) => candidate.provider === 'openclaw')
      if (openClawProviders.length > 0) {
        const existingGateways = await api<GatewayProfile[]>('GET', '/gateways')
        let shouldCreateDefault = existingGateways.length === 0

        for (const cp of openClawProviders) {
          const normalizedEndpoint = (cp.endpoint || 'http://localhost:18789').trim()
          const existing = existingGateways.find((gateway) => (
            gateway.provider === 'openclaw'
            && gateway.endpoint === normalizedEndpoint
            && (gateway.credentialId || null) === (cp.credentialId || null)
          ))
          if (existing) {
            gatewayProfileIdsByProviderConfig.set(cp.id, existing.id)
            continue
          }

          const createdGateway = await api<GatewayProfile>('POST', '/gateways', {
            name: cp.name,
            endpoint: normalizedEndpoint,
            credentialId: cp.credentialId || null,
            tags: dedup([
              'onboarding',
              ...(cp.tags || []),
            ]),
            notes: cp.notes || `Created during setup for ${cp.name}.`,
            deployment: cp.deployment || null,
            status: cp.deployment?.lastVerifiedOk ? 'healthy' : 'pending',
            isDefault: shouldCreateDefault,
          })
          gatewayProfileIdsByProviderConfig.set(cp.id, createdGateway.id)
          existingGateways.push(createdGateway)
          shouldCreateDefault = false
        }
      }

      const existingAgents = await api<Record<string, { id: string }>>('GET', '/agents')
      let canReuseDefault = !!existingAgents.default && Object.keys(existingAgents).length === 1
      const created: CreatedAgentSummary[] = []

      for (const draft of enabledDrafts) {
        const payload: Record<string, unknown> = {
          name: draft.name.trim(),
          description: draft.description.trim(),
          systemPrompt: draft.systemPrompt.trim(),
          soul: draft.soul.trim() || undefined,
          provider: draft.provider as ProviderType,
          model: draft.model.trim() || getDefaultModelForProvider(draft.provider as SetupProvider),
          credentialId: draft.credentialId || null,
          plugins: draft.tools,
          capabilities: draft.capabilities,
          platformAssignScope: draft.platformAssignScope,
          avatarSeed: draft.avatarSeed.trim() || undefined,
          avatarUrl: draft.avatarUrl || null,
        }

        if (draft.apiEndpoint) {
          payload.apiEndpoint = draft.apiEndpoint
        }
        const gatewayProfileId = (draft.providerConfigId && gatewayProfileIdsByProviderConfig.get(draft.providerConfigId)) || draft.gatewayProfileId
        if (gatewayProfileId) {
          payload.gatewayProfileId = gatewayProfileId
        }

        let agentId: string
        if (canReuseDefault) {
          await api('PUT', '/agents/default', payload)
          agentId = 'default'
          canReuseDefault = false
        } else {
          agentId = (await api<{ id: string }>('POST', '/agents', payload)).id
        }

        created.push({
          id: agentId,
          name: draft.name.trim(),
          provider: draft.provider as SetupProvider,
          providerName: configuredProviders.find((candidate) => candidate.id === draft.providerConfigId)?.name || draft.provider as SetupProvider,
        })
      }

      if (created[0]) {
        const appState = useAppStore.getState()
        await appState.updateSettings({ defaultAgentId: created[0].id })
        await appState.setCurrentAgent(created[0].id)
      }

      setStep('next')
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const saveAndContinue = async () => {
    const enabledDrafts = draftAgents.filter((draft) => draft.enabled)
    if (enabledDrafts.length === 0) {
      // No agents — go straight to "next" step
      setStep('next')
      return
    }
    await createAgentsAndFinish()
  }

  const finishSetup = async () => {
    try {
      await api('PUT', '/settings', { setupCompleted: true })
    } catch {
      // Continue anyway
    }
    onComplete()
  }

  const handleNextAddAgent = () => {
    addBlankAgent()
    setStep('agents')
  }

  return (
    <div className="h-full flex flex-col items-center px-8 bg-bg relative overflow-y-auto py-16">
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }}
        />
      </div>

      <SparkleIcon />
      <StepProgress current={stepIndex(step)} total={totalSteps} />

      {step === 'profile' && (
        <StepProfile
          onContinue={handleProfileContinue}
          onSkip={skip}
        />
      )}

      {step === 'providers' && (
        <StepProviders
          configuredProviders={configuredProviders}
          configuredProviderIds={configuredProviderIds}
          error={error}
          canContinue={canContinueFromProviders}
          onSelectProvider={selectProvider}
          onRemoveProvider={removeProvider}
          onContinue={goToAgentReview}
          onSkip={skip}
        />
      )}

      {step === 'connect' && activeProvider && selectedProvider && (
        <StepConnect
          provider={activeProvider}
          selectedProvider={selectedProvider}
          initialLabel={activeProviderLabel}
          editingProvider={editingProvider}
          configuredProviders={configuredProviders}
          starterKitId={null}
          intentText=""
          onSaveProvider={handleSaveProvider}
          onBack={handleBackFromConnect}
          onSkip={skip}
        />
      )}

      {step === 'agents' && (
        <StepAgents
          draftAgents={draftAgents}
          configuredProviders={configuredProviders}
          saving={saving}
          error={error}
          onUpdateDraft={updateDraftAgent}
          onUpdateDraftProvider={updateDraftAgentProvider}
          onSaveAndContinue={saveAndContinue}
          onRemoveAgent={removeAgent}
          onBack={() => setStep('providers')}
          onSkip={skip}
        />
      )}

      {step === 'next' && (
        <StepNext
          onAddProvider={() => setStep('providers')}
          onAddAgent={handleNextAddAgent}
          onContinueToDashboard={finishSetup}
        />
      )}

    </div>
  )
}
