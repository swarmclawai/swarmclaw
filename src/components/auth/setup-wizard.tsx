'use client'

import { useMemo, useState } from 'react'
import { api } from '@/lib/api-client'
import { OpenClawDeployPanel } from '@/components/openclaw/openclaw-deploy-panel'
import { useAppStore } from '@/stores/use-app-store'
import type { ProviderType, Credential, GatewayProfile } from '@/types'
import {
  ONBOARDING_PATHS,
  SETUP_PROVIDERS,
  STARTER_KITS,
  getDefaultModelForProvider,
  type OnboardingPath,
  type SetupProvider,
  type StarterKitAgentTemplate,
} from '@/lib/setup-defaults'

type SetupStep = 'path' | 'providers' | 'connect' | 'agents' | 'done'
type CheckState = 'idle' | 'checking' | 'ok' | 'error'

interface ProviderCheckResponse {
  ok: boolean
  message: string
  normalizedEndpoint?: string
  recommendedModel?: string
  errorCode?: string
  deviceId?: string
}

interface SetupDoctorCheck {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
  required?: boolean
}

interface SetupDoctorResponse {
  ok: boolean
  summary: string
  checks: SetupDoctorCheck[]
  actions?: string[]
}

interface SetupWizardProps {
  onComplete: () => void
}

interface ConfiguredProvider {
  id: string
  provider: SetupProvider
  name: string
  credentialId: string | null
  endpoint: string | null
  defaultModel: string
  gatewayProfileId: string | null
  notes?: string | null
  tags?: string[]
  deployment?: GatewayProfile['deployment'] | null
}

interface StarterDraftAgent {
  id: string
  templateId: string
  name: string
  description: string
  systemPrompt: string
  providerConfigId: string | null
  provider: SetupProvider | null
  model: string
  credentialId: string | null
  apiEndpoint: string | null
  gatewayProfileId: string | null
  tools: string[]
  capabilities: string[]
  platformAssignScope: 'self' | 'all'
  enabled: boolean
}

interface CreatedAgentSummary {
  id: string
  name: string
  provider: SetupProvider
  providerName: string
}

const STEP_ORDER: SetupStep[] = ['path', 'providers', 'agents', 'done']
const CONNECTOR_ICONS = [
  { name: 'Discord', icon: 'D' },
  { name: 'Slack', icon: 'S' },
  { name: 'Telegram', icon: 'T' },
  { name: 'WhatsApp', icon: 'W' },
]
const OPENCLAW_USE_CASE_LABELS: Record<NonNullable<NonNullable<GatewayProfile['deployment']>['useCase']>, string> = {
  'local-dev': 'Local Dev',
  'single-vps': 'Single VPS',
  'private-tailnet': 'Private Tailnet',
  'browser-heavy': 'Browser Heavy',
  'team-control': 'Team Control',
}
const OPENCLAW_EXPOSURE_LABELS: Record<NonNullable<NonNullable<GatewayProfile['deployment']>['exposure']>, string> = {
  'private-lan': 'Private LAN',
  tailscale: 'Tailscale',
  caddy: 'Caddy',
  nginx: 'Nginx',
  'ssh-tunnel': 'SSH Tunnel',
}

function stepIndex(step: SetupStep): number {
  if (step === 'connect') return STEP_ORDER.indexOf('providers')
  return STEP_ORDER.indexOf(step)
}

function defaultKitForPath(path: OnboardingPath): string {
  if (path === 'manual') return 'blank_workspace'
  return 'personal_assistant'
}

function applyIntentContext(prompt: string, intentText: string): string {
  const trimmed = intentText.trim()
  if (!trimmed) return prompt
  return `${prompt}

Current user intent:
- ${trimmed}

Keep your help aligned to this intent unless the user changes direction.`
}

function formatAgentCount(count: number): string {
  if (count === 0) return 'Blank'
  if (count === 1) return '1 agent'
  return `${count} agents`
}

function withHttpScheme(value: string): string {
  return /^(https?|wss?):\/\//i.test(value) ? value : `http://${value}`
}

function parseProviderUrl(value: string | null | undefined): URL | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return null
  try {
    return new URL(withHttpScheme(trimmed))
  } catch {
    return null
  }
}

function formatEndpointHost(value: string | null | undefined): string | null {
  const parsed = parseProviderUrl(value)
  if (!parsed) return null
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
}

function isLocalOpenClawEndpoint(value: string | null | undefined): boolean {
  const parsed = parseProviderUrl(value)
  if (!parsed) return false
  const host = parsed.hostname.trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

function resolveOpenClawDashboardUrl(value: string | null | undefined): string {
  const parsed = parseProviderUrl(value)
  if (!parsed) return 'http://localhost:18789'
  const next = new URL(parsed.toString())
  if (next.protocol === 'wss:') next.protocol = 'https:'
  if (next.protocol === 'ws:') next.protocol = 'http:'
  next.pathname = ''
  next.search = ''
  next.hash = ''
  return next.toString().replace(/\/+$/, '')
}

function SparkleIcon() {
  return (
    <div className="flex justify-center mb-6">
      <div className="relative w-12 h-12">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          className="text-accent-bright"
          style={{ animation: 'sparkle-spin 8s linear infinite' }}
        >
          <path
            d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
            fill="currentColor"
            opacity="0.9"
          />
        </svg>
        <div className="absolute inset-0 blur-xl bg-accent-bright/20" />
      </div>
    </div>
  )
}

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i === current
              ? 'w-6 bg-accent-bright'
              : i < current
                ? 'w-1.5 bg-accent-bright/50'
                : 'w-1.5 bg-white/10'
          }`}
        />
      ))}
    </div>
  )
}

function SkipLink({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="mt-8 text-[13px] text-text-3 hover:text-text-2 transition-colors cursor-pointer bg-transparent border-none"
    >
      {label || 'Skip setup for now'}
    </button>
  )
}

function ConfiguredProviderChips({ providers }: { providers: ConfiguredProvider[] }) {
  if (providers.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 justify-center mb-6">
      {providers.map((cp) => (
        <span
          key={cp.id}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-[12px] font-500"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {cp.name}
          <span className="text-emerald-300/70">
            {cp.provider === 'openclaw' && formatEndpointHost(cp.endpoint)
              ? `· ${formatEndpointHost(cp.endpoint)}`
              : ''}
            {cp.provider === 'openclaw' && cp.deployment?.useCase
              ? ` · ${OPENCLAW_USE_CASE_LABELS[cp.deployment.useCase]}`
              : ''}
            {cp.provider === 'openclaw' && cp.deployment?.exposure
              ? ` · ${OPENCLAW_EXPOSURE_LABELS[cp.deployment.exposure]}`
              : ''}
            {cp.defaultModel ? ` · ${cp.defaultModel}` : ''}
          </span>
        </span>
      ))}
    </div>
  )
}

function getOpenClawErrorHint(message: string): string | null {
  const lower = message.toLowerCase()
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'Ensure the port is open and reachable from this machine.'
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return 'Check your gateway auth token.'
  }
  if (lower.includes('405') || lower.includes('method not allowed')) {
    return 'Enable chatCompletions in your OpenClaw config: openclaw config set gateway.http.endpoints.chatCompletions.enabled true'
  }
  if (lower.includes('econnrefused') || lower.includes('connection refused') || lower.includes('connect econnrefused')) {
    return 'Verify that the OpenClaw gateway is running on the target host.'
  }
  return null
}

function preferredConfiguredProvider(
  template: StarterKitAgentTemplate,
  configuredProviders: ConfiguredProvider[],
  fallbackProviderConfigId?: string | null,
  fallbackProvider?: SetupProvider | null,
): ConfiguredProvider | null {
  if (fallbackProviderConfigId) {
    const exact = configuredProviders.find((candidate) => candidate.id === fallbackProviderConfigId)
    if (exact) return exact
  }

  if (fallbackProvider) {
    const exact = configuredProviders.find((candidate) => candidate.provider === fallbackProvider)
    if (exact) return exact
  }

  for (const provider of template.recommendedProviders || []) {
    const exact = configuredProviders.find((candidate) => candidate.provider === provider)
    if (exact) return exact
  }

  return configuredProviders[0] || null
}

function buildStarterDrafts(args: {
  starterKitId: string | null
  intentText: string
  configuredProviders: ConfiguredProvider[]
  previousDrafts?: StarterDraftAgent[]
}): StarterDraftAgent[] {
  const { starterKitId, intentText, configuredProviders, previousDrafts = [] } = args
  const starterKit = STARTER_KITS.find((kit) => kit.id === starterKitId)
  if (!starterKit) return []

  const previousById = new Map(previousDrafts.map((draft) => [draft.id, draft]))

  return starterKit.agents.map((template) => {
    const id = `${starterKit.id}:${template.id}`
    const previous = previousById.get(id)
    const configuredProvider = preferredConfiguredProvider(
      template,
      configuredProviders,
      previous?.providerConfigId,
      previous?.provider,
    )
    const oldProvider = previous?.provider || null
    const oldProviderDefault = oldProvider ? getDefaultModelForProvider(oldProvider) : ''
    const nextProviderDefault = configuredProvider?.defaultModel || ''
    const shouldRefreshModel =
      !previous?.model
      || (oldProvider !== configuredProvider?.provider && previous.model === oldProviderDefault)

    return {
      id,
      templateId: template.id,
      name: previous?.name || template.name,
      description: previous?.description || template.description,
      systemPrompt: previous?.systemPrompt || applyIntentContext(template.systemPrompt, intentText),
      providerConfigId: configuredProvider?.id || null,
      provider: configuredProvider?.provider || null,
      model: shouldRefreshModel ? nextProviderDefault : previous.model,
      credentialId: configuredProvider?.credentialId || null,
      apiEndpoint: configuredProvider?.endpoint || null,
      gatewayProfileId: configuredProvider?.gatewayProfileId || null,
      tools: template.tools,
      capabilities: previous?.capabilities || template.capabilities || [],
      platformAssignScope: previous?.platformAssignScope || template.platformAssignScope || 'self',
      enabled: previous?.enabled ?? true,
    }
  })
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<SetupStep>('path')
  const [onboardingPath, setOnboardingPath] = useState<OnboardingPath | null>(null)
  const [starterKitId, setStarterKitId] = useState<string | null>(null)
  const [intentText, setIntentText] = useState('')

  const [provider, setProvider] = useState<SetupProvider | null>(null)
  const [providerLabel, setProviderLabel] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [providerNotes, setProviderNotes] = useState('')
  const [providerTags, setProviderTags] = useState<string[]>([])
  const [providerDeployment, setProviderDeployment] = useState<GatewayProfile['deployment'] | null>(null)
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [checkMessage, setCheckMessage] = useState('')
  const [checkErrorCode, setCheckErrorCode] = useState<string | null>(null)
  const [openclawDeviceId, setOpenclawDeviceId] = useState<string | null>(null)
  const [providerSuggestedModel, setProviderSuggestedModel] = useState('')

  const [doctorState, setDoctorState] = useState<'idle' | 'checking' | 'done' | 'error'>('idle')
  const [doctorError, setDoctorError] = useState('')
  const [doctorReport, setDoctorReport] = useState<SetupDoctorResponse | null>(null)
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])
  const [draftAgents, setDraftAgents] = useState<StarterDraftAgent[]>([])
  const [createdAgents, setCreatedAgents] = useState<CreatedAgentSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedProvider = useMemo(
    () => SETUP_PROVIDERS.find((candidate) => candidate.id === provider) || null,
    [provider],
  )
  const selectedStarterKit = useMemo(
    () => STARTER_KITS.find((candidate) => candidate.id === starterKitId) || null,
    [starterKitId],
  )
  const totalSteps = STEP_ORDER.length
  const singleUseProviderIds = new Set(
    configuredProviders
      .filter((cp) => !SETUP_PROVIDERS.find((candidate) => candidate.id === cp.provider)?.allowMultiple)
      .map((cp) => cp.provider),
  )

  const requiresKey = selectedProvider?.requiresKey || false
  const supportsEndpoint = selectedProvider?.supportsEndpoint || false
  const keyIsOptional = selectedProvider?.optionalKey || false
  const requiresVerifiedConnection = provider === 'openclaw'
  const canContinueFromProviders = configuredProviders.length > 0 || (selectedStarterKit?.agents.length || 0) === 0
  const openClawEndpointValue = provider === 'openclaw'
    ? (endpoint.trim() || selectedProvider?.defaultEndpoint || 'http://localhost:18789/v1')
    : null
  const openClawEndpointHost = openClawEndpointValue ? formatEndpointHost(openClawEndpointValue) : null
  const openClawDashboardUrl = provider === 'openclaw'
    ? resolveOpenClawDashboardUrl(openClawEndpointValue)
    : null
  const openClawLocal = provider === 'openclaw' ? isLocalOpenClawEndpoint(openClawEndpointValue) : false

  const resetProviderForm = () => {
    setProvider(null)
    setProviderLabel('')
    setEndpoint('')
    setApiKey('')
    setCredentialId(null)
    setProviderNotes('')
    setProviderTags([])
    setProviderDeployment(null)
    setCheckState('idle')
    setCheckMessage('')
    setCheckErrorCode(null)
    setOpenclawDeviceId(null)
    setProviderSuggestedModel('')
    setError('')
  }

  const skip = async () => {
    try {
      await api('PUT', '/settings', { setupCompleted: true })
    } catch {
      // Continue anyway.
    }
    onComplete()
  }

  const applyPathSelection = (nextPath: OnboardingPath) => {
    setOnboardingPath(nextPath)
    setStarterKitId((current) => current || defaultKitForPath(nextPath))
    setError('')
  }

  const continueFromPath = () => {
    if (!onboardingPath) {
      setError('Choose how you want to get started.')
      return
    }
    if (!starterKitId) {
      setError('Choose a starter kit or blank workspace.')
      return
    }

    setDraftAgents(buildStarterDrafts({
      starterKitId,
      intentText,
      configuredProviders,
    }))
    setError('')
    setStep('providers')
  }

  const selectProvider = (nextProvider: SetupProvider) => {
    const meta = SETUP_PROVIDERS.find((candidate) => candidate.id === nextProvider)
    const nextCount = configuredProviders.filter((candidate) => candidate.provider === nextProvider).length + 1
    setProvider(nextProvider)
    setProviderLabel(meta?.allowMultiple ? `${meta.name} ${nextCount}` : (meta?.name || ''))
    setEndpoint(meta?.defaultEndpoint || '')
    setApiKey('')
    setCredentialId(null)
    setProviderNotes('')
    setProviderTags([])
    setProviderDeployment(null)
    setCheckState('idle')
    setCheckMessage('')
    setCheckErrorCode(null)
    setOpenclawDeviceId(null)
    setProviderSuggestedModel(getDefaultModelForProvider(nextProvider))
    setError('')
    setStep('connect')
  }

  const applyOpenClawDeployPatch = (patch: {
    endpoint?: string
    token?: string
    name?: string
    notes?: string
    deployment?: GatewayProfile['deployment'] | Record<string, unknown> | null
  }) => {
    if (patch.endpoint) {
      setEndpoint(patch.endpoint)
    }
    if (patch.token) {
      setApiKey(patch.token)
      setCredentialId(null)
    }
    if (patch.name && (!providerLabel.trim() || providerLabel.trim() === (selectedProvider?.name || ''))) {
      setProviderLabel(patch.name)
    }
    if (patch.notes) {
      setProviderNotes(patch.notes)
    }
    if (patch.deployment) {
      const nextDeployment = patch.deployment as GatewayProfile['deployment']
      setProviderDeployment((current) => ({
        ...(current || {}),
        ...(nextDeployment || {}),
      }))
      setProviderTags((current) => Array.from(new Set([
        ...current,
        'onboarding',
        ...(nextDeployment?.useCase ? [nextDeployment.useCase] : []),
        ...(nextDeployment?.exposure ? [nextDeployment.exposure] : []),
      ])))
    }
    setCheckState('idle')
    setCheckMessage('')
    setCheckErrorCode(null)
    setError('')
  }

  const runConnectionCheck = async (): Promise<boolean> => {
    if (!provider || !selectedProvider) return false
    if (requiresKey && !apiKey.trim()) {
      setCheckState('error')
      setCheckMessage('Please paste your API key first.')
      return false
    }

    setCheckState('checking')
    setCheckMessage('')
    setCheckErrorCode(null)
    setError('')
    try {
      const result = await api<ProviderCheckResponse>('POST', '/setup/check-provider', {
        provider,
        apiKey: apiKey.trim() || undefined,
        endpoint: supportsEndpoint ? endpoint.trim() || undefined : undefined,
      })

      if (result.normalizedEndpoint && supportsEndpoint) {
        setEndpoint(result.normalizedEndpoint)
      }
      if (result.recommendedModel) {
        setProviderSuggestedModel(result.recommendedModel)
      }
      setCheckErrorCode(result.errorCode || null)
      setOpenclawDeviceId(result.deviceId || null)
      setCheckState(result.ok ? 'ok' : 'error')
      setCheckMessage(result.message || (result.ok ? 'Connected successfully.' : 'Connection failed.'))
      return !!result.ok
    } catch (err: unknown) {
      setCheckState('error')
      setCheckMessage(err instanceof Error ? err.message : String(err))
      setCheckErrorCode(null)
      return false
    }
  }

  const runSetupDoctor = async () => {
    setDoctorState('checking')
    setDoctorError('')
    try {
      const report = await api<SetupDoctorResponse>('GET', '/setup/doctor')
      setDoctorReport(report)
      setDoctorState('done')
    } catch (err: unknown) {
      setDoctorState('error')
      setDoctorReport(null)
      setDoctorError(err instanceof Error ? err.message : String(err))
    }
  }

  const saveProvider = async () => {
    if (!provider || !selectedProvider) return
    if (requiresKey && !apiKey.trim()) {
      setError('This provider requires an API key.')
      return
    }

    setSaving(true)
    setError('')
    try {
      if (requiresVerifiedConnection && checkState !== 'ok') {
        const ok = await runConnectionCheck()
        if (!ok) {
          setError('OpenClaw must pass connection verification before continuing.')
          return
        }
      }

      let nextCredentialId = credentialId
      const shouldSaveCredential = !!apiKey.trim() && (requiresKey || keyIsOptional)

      if (shouldSaveCredential && !nextCredentialId) {
        const cred = await api<Credential>('POST', '/credentials', {
          provider,
          name: `${providerLabel.trim() || selectedProvider.name} key`,
          apiKey: apiKey.trim(),
        })
        nextCredentialId = cred.id
      }

      const configuredProvider: ConfiguredProvider = {
        id: crypto.randomUUID(),
        provider,
        name: providerLabel.trim() || selectedProvider.name,
        credentialId: nextCredentialId || null,
        endpoint: supportsEndpoint ? (endpoint.trim() || selectedProvider.defaultEndpoint || null) : null,
        defaultModel: providerSuggestedModel || getDefaultModelForProvider(provider),
        gatewayProfileId: null,
        notes: providerNotes.trim() || null,
        tags: providerTags,
        deployment: providerDeployment,
      }

      const nextConfigured = [...configuredProviders, configuredProvider]
      setCredentialId(nextCredentialId || null)
      setConfiguredProviders(nextConfigured)
      setDraftAgents((current) => buildStarterDrafts({
        starterKitId,
        intentText,
        configuredProviders: nextConfigured,
        previousDrafts: current,
      }))
      resetProviderForm()
      setStep('providers')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const goToAgentReview = () => {
    setDraftAgents((current) => buildStarterDrafts({
      starterKitId,
      intentText,
      configuredProviders,
      previousDrafts: current,
    }))
    setError('')
    setStep('agents')
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
      const gatewayProfileIdsByProviderConfig = new Map<string, string>()
      const openClawProviders = configuredProviders.filter((candidate) => candidate.provider === 'openclaw')
      if (openClawProviders.length > 0) {
        const existingGateways = await api<GatewayProfile[]>('GET', '/gateways')
        let shouldCreateDefault = existingGateways.length === 0

        for (const configuredProvider of openClawProviders) {
          const normalizedEndpoint = (configuredProvider.endpoint || 'http://localhost:18789').trim()
          const existing = existingGateways.find((gateway) => (
            gateway.provider === 'openclaw'
            && gateway.endpoint === normalizedEndpoint
            && (gateway.credentialId || null) === (configuredProvider.credentialId || null)
          ))
          if (existing) {
            gatewayProfileIdsByProviderConfig.set(configuredProvider.id, existing.id)
            continue
          }

          const createdGateway = await api<GatewayProfile>('POST', '/gateways', {
            name: configuredProvider.name,
            endpoint: normalizedEndpoint,
            credentialId: configuredProvider.credentialId || null,
            tags: Array.from(new Set([
              'onboarding',
              ...(configuredProvider.tags || []),
            ])),
            notes: configuredProvider.notes || `Created during setup for ${configuredProvider.name}.`,
            deployment: configuredProvider.deployment || null,
            status: configuredProvider.deployment?.lastVerifiedOk ? 'healthy' : 'pending',
            isDefault: shouldCreateDefault,
          })
          gatewayProfileIdsByProviderConfig.set(configuredProvider.id, createdGateway.id)
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
          provider: draft.provider as ProviderType,
          model: draft.model.trim() || getDefaultModelForProvider(draft.provider as SetupProvider),
          credentialId: draft.credentialId || null,
          plugins: draft.tools,
          capabilities: draft.capabilities,
          platformAssignScope: draft.platformAssignScope,
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

      await api('PUT', '/settings', { setupCompleted: true })
      setCreatedAgents(created)
      setStep('done')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const finishWithoutAgents = async () => {
    setSaving(true)
    setError('')
    try {
      await api('PUT', '/settings', { setupCompleted: true })
      setCreatedAgents([])
      setStep('done')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 bg-bg relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }}
        />
      </div>

      <div
        className="relative max-w-[760px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <SparkleIcon />
        <StepDots current={stepIndex(step)} total={totalSteps} />

        {step === 'path' && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Choose Your Setup Path
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              Start from your intent, start from your provider, or build it yourself.
            </p>
            <p className="text-[13px] text-text-3 mb-8">
              You can still change providers, models, agents, and templates later.
            </p>

            <div className="grid gap-3 md:grid-cols-3 text-left mb-6">
              {ONBOARDING_PATHS.map((path) => {
                const active = onboardingPath === path.id
                return (
                  <button
                    key={path.id}
                    onClick={() => applyPathSelection(path.id)}
                    className={`rounded-[16px] border px-5 py-4 transition-all duration-200 cursor-pointer ${
                      active
                        ? 'border-accent-bright/40 bg-accent-bright/10'
                        : 'border-white/[0.08] bg-surface hover:border-accent-bright/20 hover:bg-surface-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[15px] font-display font-700 text-text">{path.title}</span>
                      {path.badge && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-accent-bright/15 text-accent-bright text-[10px] uppercase tracking-[0.08em] font-600">
                          {path.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] text-text-2 leading-relaxed mb-2">{path.description}</p>
                    <p className="text-[12px] text-text-3 leading-relaxed">{path.detail}</p>
                  </button>
                )
              })}
            </div>

            {onboardingPath === 'intent' && (
              <div className="mb-6 text-left rounded-[16px] border border-white/[0.08] bg-surface p-4">
                <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
                  What do you want SwarmClaw to help with?
                </label>
                <textarea
                  value={intentText}
                  onChange={(e) => setIntentText(e.target.value)}
                  rows={3}
                  placeholder="Examples: help me research AI products, build a SaaS app, manage personal projects, write better content..."
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                    text-text text-[14px] outline-none transition-all duration-200 resize-none
                    focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                />
                <p className="mt-2 text-[12px] text-text-3">
                  This is used to tailor your starter agents. You can leave it blank and refine later.
                </p>
              </div>
            )}

            <div className="text-left mb-6">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-[13px] font-600 text-text">Starter Kits</div>
                  <div className="text-[12px] text-text-3">Choose a template or start blank. You can opt individual agents in or out on the next screen.</div>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {STARTER_KITS.map((kit) => {
                  const active = starterKitId === kit.id
                  return (
                    <button
                      key={kit.id}
                      onClick={() => setStarterKitId(kit.id)}
                      className={`rounded-[16px] border px-5 py-4 text-left transition-all duration-200 cursor-pointer ${
                        active
                          ? 'border-accent-bright/40 bg-accent-bright/10'
                          : 'border-white/[0.08] bg-surface hover:border-accent-bright/20 hover:bg-surface-hover'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[15px] font-display font-700 text-text">{kit.name}</span>
                        {kit.badge && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/[0.06] text-text-2 text-[10px] uppercase tracking-[0.08em] font-600">
                            {kit.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-[13px] text-text-2 mb-2">{kit.description}</p>
                      <p className="text-[12px] text-text-3 leading-relaxed mb-3">{kit.detail}</p>
                      <div className="flex items-center gap-2 text-[11px] text-text-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06]">
                          {formatAgentCount(kit.agents.length)}
                        </span>
                        {kit.recommendedFor?.includes(onboardingPath || 'quick') && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                            Fits this path
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={continueFromPath}
                disabled={!onboardingPath || !starterKitId}
                className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                Continue
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {step === 'providers' && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Connect Providers
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              Add one or more providers, then map them onto your starter agents.
            </p>
            <p className="text-[13px] text-text-3 mb-8">
              Providers are reusable. You will choose or change the provider and model for each starter agent on the next step.
            </p>

            {selectedStarterKit && (
              <div className="mb-6 p-4 rounded-[14px] border border-white/[0.08] bg-surface text-left">
                <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Starter Kit</div>
                <div className="text-[14px] text-text mb-1">{selectedStarterKit.name}</div>
                <div className="text-[12px] text-text-3">{selectedStarterKit.detail}</div>
                {!!intentText.trim() && (
                  <div className="mt-3 text-[12px] text-text-2">
                    Intent: <span className="text-text-3">{intentText.trim()}</span>
                  </div>
                )}
              </div>
            )}

            <ConfiguredProviderChips providers={configuredProviders} />

            <div className="flex flex-col gap-3 max-h-[42vh] overflow-y-auto pr-1">
              {SETUP_PROVIDERS.map((candidate) => {
                const isConfigured = !candidate.allowMultiple && singleUseProviderIds.has(candidate.id)
                const configuredCount = configuredProviders.filter((cp) => cp.provider === candidate.id).length
                return (
                  <button
                    key={candidate.id}
                    onClick={() => !isConfigured && selectProvider(candidate.id)}
                    disabled={isConfigured}
                    className={`w-full px-5 py-4 rounded-[14px] border border-white/[0.08] bg-surface text-left
                      transition-all duration-200 flex items-start gap-4
                      ${isConfigured
                        ? 'opacity-40 cursor-not-allowed'
                        : 'cursor-pointer hover:border-accent-bright/30 hover:bg-surface-hover'
                      }`}
                  >
                    <div className="w-10 h-10 rounded-[10px] bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[16px] font-display font-700 text-accent-bright">
                        {candidate.icon}
                      </span>
                    </div>
                    <div>
                      <div className="text-[15px] font-display font-600 text-text mb-1">
                        {candidate.name}
                        {isConfigured ? (
                          <span className="ml-2 text-[10px] text-emerald-400 uppercase tracking-[0.08em]">Ready</span>
                        ) : candidate.allowMultiple && configuredCount > 0 ? (
                          <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 text-[10px] uppercase tracking-[0.08em] font-600">
                            {configuredCount} saved
                          </span>
                        ) : candidate.badge ? (
                          <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent-bright/15 text-accent-bright text-[10px] uppercase tracking-[0.08em] font-600">
                            {candidate.badge}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[13px] text-text-3 leading-relaxed">{candidate.description}</div>
                      {!candidate.requiresKey && !isConfigured && (
                        <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-[11px] font-500">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          No API key required
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="mt-4 text-left">
              <button
                onClick={runSetupDoctor}
                disabled={doctorState === 'checking'}
                className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-white/[0.02] text-[13px] text-text-2
                  cursor-pointer hover:bg-white/[0.05] transition-all duration-200 disabled:opacity-40"
              >
                {doctorState === 'checking' ? 'Running System Check...' : 'Run System Check'}
              </button>

              {doctorState === 'error' && doctorError && (
                <p className="mt-2 text-[12px] text-red-300">{doctorError}</p>
              )}

              {doctorReport && doctorState === 'done' && (
                <div className="mt-3 p-3 rounded-[12px] border border-white/[0.08] bg-surface">
                  <div className={`text-[12px] font-600 ${doctorReport.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {doctorReport.summary}
                  </div>
                  {doctorReport.checks.filter((check) => check.status !== 'pass').slice(0, 3).map((check) => (
                    <div key={check.id} className="mt-1 text-[11px] text-text-3">
                      - {check.label}: {check.detail}
                    </div>
                  ))}
                  {!!doctorReport.actions?.length && (
                    <div className="mt-2 text-[11px] text-text-3/80">
                      Next: {doctorReport.actions.slice(0, 2).join(' ')}
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && <p className="mt-4 text-[13px] text-red-400">{error}</p>}

            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                onClick={() => setStep('path')}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                  font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
              >
                Back
              </button>
              <button
                onClick={goToAgentReview}
                disabled={!canContinueFromProviders}
                className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                {selectedStarterKit?.agents.length ? 'Review Starter Agents' : 'Continue'}
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {step === 'connect' && provider && selectedProvider && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Connect {selectedProvider.name}
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              Save this provider once, then reuse it across your starter agents.
            </p>
            <p className="text-[13px] text-text-3 mb-7">
              {requiresVerifiedConnection
                ? 'OpenClaw must pass connection check before you can continue.'
                : 'You can still continue even if the check fails and fix details later.'}
            </p>

            <div className="flex flex-col gap-3 text-left mb-4">
              <div>
                <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
                  Connection name
                </label>
                <input
                  type="text"
                  value={providerLabel}
                  onChange={(e) => setProviderLabel(e.target.value)}
                  placeholder={selectedProvider.name}
                  className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                    text-text text-[14px] outline-none transition-all duration-200
                    focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                />
                <p className="mt-1.5 text-[11px] text-text-3">
                  Helpful for multiple OpenClaw gateways or distinct provider profiles.
                </p>
              </div>

              {supportsEndpoint && (
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
                    Endpoint
                  </label>
                  <input
                    type="text"
                    value={endpoint}
                    onChange={(e) => { setEndpoint(e.target.value); setCheckState('idle'); setCheckMessage('') }}
                    placeholder={selectedProvider.defaultEndpoint || ''}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                      text-text text-[14px] font-mono outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                  {provider === 'openclaw' && (
                    <div className="mt-2 space-y-0.5">
                      <p className="text-[12px] text-text-3">Works with local (<code className="text-text-2">http://localhost:18789/v1</code>) or remote OpenClaw instances.</p>
                      <p className="text-[12px] text-text-3">Remote example: <code className="text-text-2">https://your-gateway.ts.net/v1</code>.</p>
                    </div>
                  )}
                </div>
              )}

              {provider === 'openclaw' && (
                <div className="rounded-[14px] border border-white/[0.08] bg-surface p-4 space-y-4">
                  <OpenClawDeployPanel
                    compact
                    endpoint={openClawEndpointValue}
                    token={apiKey}
                    suggestedName={providerLabel || selectedProvider.name}
                    title="Smart Deploy OpenClaw"
                    description="Launch the bundled official OpenClaw gateway locally, or generate an official-image VPS bundle for major providers without relying on third-party deployment services."
                    onApply={applyOpenClawDeployPatch}
                  />

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
                      <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Remote gateway</div>
                      <p className="text-[13px] text-text-2 leading-relaxed">
                        Recommended when your OpenClaw node runs on another machine or VPS. Use a URL reachable from the machine running SwarmClaw.
                      </p>
                      <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                        Tailscale example: <code className="text-text-2">https://&lt;gateway-host&gt;.ts.net/v1</code>
                      </p>
                      <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                        If you only have a WebSocket gateway URL, you can still paste it here. SwarmClaw will normalize it for agent chat.
                      </p>
                      <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                        Safer remote defaults: use <code className="text-text-2">private-tailnet</code> with <code className="text-text-2">tailscale</code> or <code className="text-text-2">ssh-tunnel</code> unless you intentionally want public HTTPS ingress.
                      </p>
                    </div>
                    <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
                      <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Safe defaults</div>
                      <p className="text-[13px] text-text-2 leading-relaxed">
                        Smart Deploy generates a gateway token for you, defaults to the standard OpenClaw ports, and prefills this setup form automatically.
                      </p>
                      <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                        Local quickstart uses the bundled official OpenClaw CLI. Remote quickstart uses the official OpenClaw Docker image or the official repo for managed hosts.
                      </p>
                      <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                        Choose <code className="text-text-2">local-dev</code> for one-machine setup, <code className="text-text-2">single-vps</code> for most hosted installs, or <code className="text-text-2">private-tailnet</code> when the gateway should stay private.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-3">
                    <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Connection mental model</div>
                    <p className="text-[12px] text-text-3 leading-relaxed">
                      SwarmClaw talks to this endpoint from its own host. If SwarmClaw is on a server, <code className="text-text-2">localhost</code> means that server, not your laptop.
                    </p>
                    <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                      Current target: <span className="text-text-2">{openClawEndpointHost || 'localhost:18789'}</span>{openClawLocal ? ' · local route' : ' · remote route'}
                    </p>
                    <p className="mt-2 text-[12px] text-text-3 leading-relaxed">
                      Use <code className="text-text-2">caddy</code> or <code className="text-text-2">nginx</code> only when you intentionally want HTTPS/public ingress managed on the gateway side.
                    </p>
                  </div>
                </div>
              )}

              {(requiresKey || keyIsOptional) && (
                <div>
                  <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">
                    {keyIsOptional ? 'Token (optional)' : 'API key'}
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setCheckState('idle'); setCheckMessage(''); setError('') }}
                    placeholder={selectedProvider.keyPlaceholder || (provider === 'openclaw' ? 'Paste OpenClaw bearer token' : 'sk-...')}
                    className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                      text-text text-[14px] font-mono outline-none transition-all duration-200
                      focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                  />
                  {selectedProvider.keyUrl && (
                    <p className="text-[11px] text-text-3 mt-1.5">
                      Get one at{' '}
                      <a
                        href={selectedProvider.keyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-bright hover:underline"
                      >
                        {selectedProvider.keyLabel}
                      </a>
                    </p>
                  )}
                </div>
              )}
            </div>

            {checkState !== 'idle' && (
              <div
                className={`mb-4 px-3 py-2 rounded-[10px] text-[12px] border ${
                  checkState === 'ok'
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    : checkState === 'checking'
                      ? 'bg-white/[0.03] border-white/[0.08] text-text-2'
                      : 'bg-red-500/10 border-red-500/25 text-red-300'
                }`}
              >
                {checkState === 'checking' ? 'Checking connection...' : checkMessage}
                {checkState === 'error' && provider === 'openclaw' && (() => {
                  const hint = getOpenClawErrorHint(checkMessage)
                  return hint ? <p className="mt-1.5 text-[11px] text-text-3">{hint}</p> : null
                })()}
                {providerSuggestedModel && (
                  <p className="mt-1.5 text-[11px] text-text-3">Suggested model: {providerSuggestedModel}</p>
                )}
                {provider === 'openclaw' && checkState === 'ok' && openclawDeviceId && (
                  <p className="mt-1.5 text-[11px] text-text-3">
                    Device paired as <code className="text-text-2">{openclawDeviceId.slice(0, 12)}...</code>.
                  </p>
                )}
              </div>
            )}

            {provider === 'openclaw' && checkState === 'error' && checkErrorCode === 'PAIRING_REQUIRED' && (
              <div className="mb-4 rounded-[12px] border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-left">
                <div className="text-[13px] font-600 text-emerald-300">Awaiting gateway approval</div>
                <p className="mt-1.5 text-[12px] text-text-3 leading-relaxed">
                  This device is pending approval on that OpenClaw gateway. Approve it from Nodes, then run the connection check again.
                  {openclawDeviceId ? (
                    <> Device: <code className="text-text-2">{openclawDeviceId}</code>.</>
                  ) : null}
                </p>
                {openClawDashboardUrl && (
                  <a
                    href={openClawDashboardUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-text hover:bg-white/[0.06] transition-all duration-200"
                  >
                    Open gateway dashboard
                  </a>
                )}
              </div>
            )}

            {provider === 'openclaw' && checkState === 'error' && checkErrorCode === 'DEVICE_AUTH_INVALID' && (
              <div className="mb-4 rounded-[12px] border border-white/[0.08] bg-surface px-4 py-3 text-left">
                <div className="text-[13px] font-600 text-text">Device not paired</div>
                <p className="mt-1.5 text-[12px] text-text-3 leading-relaxed">
                  The gateway does not recognize this device yet. Add or approve it from Nodes, then retry.
                  {openclawDeviceId ? (
                    <> Device: <code className="text-text-2">{openclawDeviceId}</code>.</>
                  ) : null}
                </p>
              </div>
            )}

            {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => { resetProviderForm(); setStep('providers') }}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                  font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
              >
                Back
              </button>
              <button
                onClick={runConnectionCheck}
                disabled={checkState === 'checking' || saving}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-white/[0.03] text-text text-[14px]
                  font-display font-600 cursor-pointer hover:bg-white/[0.06] transition-all duration-200 disabled:opacity-40"
              >
                {checkState === 'checking' ? 'Checking...' : 'Check Connection'}
              </button>
              <button
                onClick={saveProvider}
                disabled={(requiresKey && !apiKey.trim()) || saving}
                className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                {saving ? 'Saving...' : 'Save Provider'}
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {step === 'agents' && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Review Starter Agents
            </h1>
            <p className="text-[15px] text-text-2 mb-2">
              Choose which agents to start with, then adjust provider and model per agent.
            </p>
            <p className="text-[13px] text-text-3 mb-7">
              These are just starting points. You can edit them later from Agents.
            </p>

            {selectedStarterKit && (
              <div className="mb-5 p-4 rounded-[14px] border border-white/[0.08] bg-surface text-left">
                <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-2">Setup Summary</div>
                <div className="text-[14px] text-text mb-1">{selectedStarterKit.name}</div>
                <div className="text-[12px] text-text-3">{selectedStarterKit.detail}</div>
                {!!intentText.trim() && (
                  <div className="mt-3 text-[12px] text-text-2">
                    Intent: <span className="text-text-3">{intentText.trim()}</span>
                  </div>
                )}
                <div className="mt-3 text-[12px] text-text-3">
                  Providers ready: {configuredProviders.length || 'none'}
                </div>
              </div>
            )}

            {draftAgents.length === 0 ? (
              <div className="mb-6 p-6 rounded-[16px] border border-white/[0.08] bg-surface text-left">
                <div className="text-[16px] font-display font-700 text-text mb-2">Blank workspace selected</div>
                <p className="text-[13px] text-text-3 leading-relaxed">
                  Finish setup now and create your first provider, agent, task, or project later from inside the app.
                </p>
              </div>
            ) : (
              <div className="space-y-4 max-h-[46vh] overflow-y-auto pr-1 text-left mb-6">
                {draftAgents.map((draft) => (
                  <div key={draft.id} className="rounded-[16px] border border-white/[0.08] bg-surface p-4">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <div>
                        <div className="text-[15px] font-display font-700 text-text">{draft.name}</div>
                        <div className="text-[12px] text-text-3">{draft.description}</div>
                      </div>
                      <label className="inline-flex items-center gap-2 text-[12px] text-text-2">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(e) => updateDraftAgent(draft.id, { enabled: e.target.checked })}
                        />
                        Start with this agent
                      </label>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Name</label>
                        <input
                          type="text"
                          value={draft.name}
                          onChange={(e) => updateDraftAgent(draft.id, { name: e.target.value })}
                          className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                            text-text text-[14px] outline-none transition-all duration-200
                            focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Provider</label>
                        <select
                          value={draft.providerConfigId || ''}
                          onChange={(e) => updateDraftAgentProvider(draft.id, e.target.value)}
                          className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                            text-text text-[14px] outline-none transition-all duration-200
                            focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                        >
                          <option value="">Choose provider</option>
                          {configuredProviders.map((configuredProvider) => (
                            <option key={configuredProvider.id} value={configuredProvider.id}>
                              {configuredProvider.name}
                              {configuredProvider.provider === 'openclaw' && formatEndpointHost(configuredProvider.endpoint)
                                ? ` · ${formatEndpointHost(configuredProvider.endpoint)}`
                                : ''}
                              {configuredProvider.provider === 'openclaw' && configuredProvider.deployment?.useCase
                                ? ` · ${OPENCLAW_USE_CASE_LABELS[configuredProvider.deployment.useCase]}`
                                : ''}
                              {configuredProvider.provider === 'openclaw' && configuredProvider.deployment?.exposure
                                ? ` · ${OPENCLAW_EXPOSURE_LABELS[configuredProvider.deployment.exposure]}`
                                : ''}
                              {configuredProvider.defaultModel ? ` · ${configuredProvider.defaultModel}` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Description</label>
                        <input
                          type="text"
                          value={draft.description}
                          onChange={(e) => updateDraftAgent(draft.id, { description: e.target.value })}
                          className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                            text-text text-[14px] outline-none transition-all duration-200
                            focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Model</label>
                        <input
                          type="text"
                          value={draft.model}
                          onChange={(e) => updateDraftAgent(draft.id, { model: e.target.value })}
                          className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                            text-text text-[14px] font-mono outline-none transition-all duration-200
                            focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Mode</label>
                        <select
                          value={draft.platformAssignScope}
                          onChange={(e) => updateDraftAgent(draft.id, { platformAssignScope: e.target.value as 'self' | 'all' })}
                          className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                            text-text text-[14px] outline-none transition-all duration-200
                            focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                        >
                          <option value="self">Focused agent</option>
                          <option value="all">Delegating orchestrator</option>
                        </select>
                      </div>
                    </div>

                    <details className="mt-4 rounded-[12px] border border-white/[0.08] bg-bg px-4 py-3">
                      <summary className="cursor-pointer text-[13px] text-text-2 font-600">
                        Prompt and tools
                      </summary>
                      <div className="mt-3 space-y-3">
                        <div>
                          <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">System Prompt</label>
                          <textarea
                            value={draft.systemPrompt}
                            onChange={(e) => updateDraftAgent(draft.id, { systemPrompt: e.target.value })}
                            rows={5}
                            className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                              text-text text-[14px] outline-none transition-all duration-200 resize-none
                              focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                          />
                        </div>
                        <div>
                          <div className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Tools</div>
                          <div className="flex flex-wrap gap-2">
                            {draft.tools.map((tool) => (
                              <span
                                key={tool}
                                className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[11px] text-text-2"
                              >
                                {tool}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            )}

            {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setStep('providers')}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
                  font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
              >
                Back
              </button>
              <button
                onClick={() => setStep('providers')}
                className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-white/[0.03] text-text text-[14px]
                  font-display font-600 cursor-pointer hover:bg-white/[0.06] transition-all duration-200"
              >
                Add Another Provider
              </button>
              <button
                onClick={draftAgents.length === 0 ? finishWithoutAgents : createAgentsAndFinish}
                disabled={saving}
                className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                {saving
                  ? 'Saving...'
                  : draftAgents.length === 0
                    ? 'Finish Setup'
                    : `Create ${draftAgents.filter((draft) => draft.enabled).length} Agent${draftAgents.filter((draft) => draft.enabled).length === 1 ? '' : 's'}`}
              </button>
            </div>

            <SkipLink onClick={skip} />
          </>
        )}

        {step === 'done' && (
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              You&apos;re All Set
            </h1>
            <p className="text-[15px] text-text-2 mb-7">
              {createdAgents.length === 0
                ? 'Your workspace is ready. Add providers and agents whenever you want.'
                : createdAgents.length === 1
                  ? 'Your starter agent is ready to chat.'
                  : `${createdAgents.length} starter agents are ready to go.`}
            </p>

            {createdAgents.length > 0 && (
              <div className="mb-6 p-4 rounded-[14px] border border-white/[0.08] bg-surface text-left">
                <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-3">Agents Created</div>
                <div className="space-y-2">
                  {createdAgents.map((agent) => {
                    const meta = SETUP_PROVIDERS.find((candidate) => candidate.id === agent.provider)
                    return (
                      <div key={agent.id} className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-[8px] bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0">
                          <span className="text-[13px] font-display font-700 text-accent-bright">
                            {meta?.icon || '?'}
                          </span>
                        </div>
                        <div>
                          <div className="text-[14px] text-text font-500">{agent.name}</div>
                          <div className="text-[12px] text-text-3">
                            {agent.providerName}
                            {agent.providerName !== (meta?.name || agent.provider) ? ` · ${meta?.name || agent.provider}` : ''}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="mb-8 p-4 rounded-[14px] border border-white/[0.08] bg-surface text-left">
              <div className="text-[12px] uppercase tracking-[0.08em] text-text-3 mb-3">Next Up — Connectors</div>
              <p className="text-[13px] text-text-2 mb-3">
                Bridge your agents to chat platforms any time from Connectors.
              </p>
              <div className="flex gap-3">
                {CONNECTOR_ICONS.map((connector) => (
                  <div key={connector.name} className="flex flex-col items-center gap-1.5">
                    <div className="w-10 h-10 rounded-[10px] bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                      <span className="text-[14px] font-display font-600 text-text-3">{connector.icon}</span>
                    </div>
                    <span className="text-[10px] text-text-3">{connector.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={onComplete}
              className="px-10 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
                cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
            >
              Get Started
            </button>
          </>
        )}
      </div>
    </div>
  )
}
