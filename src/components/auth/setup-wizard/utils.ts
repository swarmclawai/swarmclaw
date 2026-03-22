import {
  STARTER_KITS,
  getDefaultModelForProvider,
  type OnboardingPath,
  type SetupProvider,
  type StarterKitAgentTemplate,
} from '@/lib/setup-defaults'
import type { ConfiguredProvider, SetupStep, StarterDraftAgent } from './types'
import { STEP_ORDER } from './types'

export function stepIndex(step: SetupStep): number {
  if (step === 'connect') return STEP_ORDER.indexOf('providers')
  return STEP_ORDER.indexOf(step)
}

export function defaultKitForPath(path: OnboardingPath): string {
  if (path === 'manual') return 'blank_workspace'
  return 'personal_assistant'
}

export function applyIntentContext(prompt: string, intentText: string): string {
  const trimmed = intentText.trim()
  if (!trimmed) return prompt
  return `${prompt}

Current user intent:
- ${trimmed}

Keep your help aligned to this intent unless the user changes direction.`
}

export function formatAgentCount(count: number): string {
  if (count === 0) return 'Blank'
  if (count === 1) return '1 agent'
  return `${count} agents`
}

export function withHttpScheme(value: string): string {
  return /^(https?|wss?):\/\//i.test(value) ? value : `http://${value}`
}

export function parseProviderUrl(value: string | null | undefined): URL | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return null
  try {
    return new URL(withHttpScheme(trimmed))
  } catch {
    return null
  }
}

export function formatEndpointHost(value: string | null | undefined): string | null {
  const parsed = parseProviderUrl(value)
  if (!parsed) return null
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
}

export function isLocalOpenClawEndpoint(value: string | null | undefined): boolean {
  const parsed = parseProviderUrl(value)
  if (!parsed) return false
  const host = parsed.hostname.trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

export function resolveOpenClawDashboardUrl(value: string | null | undefined): string {
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

export function getOpenClawErrorHint(message: string): string | null {
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

export function requiresSetupProviderVerification(provider: SetupProvider | null | undefined): boolean {
  return provider != null && provider !== 'openclaw' && provider !== 'custom'
}

export function preferredConfiguredProvider(
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
    const exact = configuredProviders.find((candidate) => candidate.setupProvider === fallbackProvider)
    if (exact) return exact
  }

  for (const provider of template.recommendedProviders || []) {
    const exact = configuredProviders.find((candidate) => candidate.setupProvider === provider)
    if (exact) return exact
  }

  return configuredProviders[0] || null
}

export function buildStarterDrafts(args: {
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
      previous?.setupProvider,
    )
    const oldProvider = previous?.setupProvider || null
    const previousModel = previous?.model || ''
    const oldProviderDefault = oldProvider ? getDefaultModelForProvider(oldProvider) : ''
    const nextProviderDefault = configuredProvider?.defaultModel || ''
    const shouldRefreshModel =
      !previousModel.trim()
      || (oldProvider !== configuredProvider?.setupProvider && previousModel === oldProviderDefault)

    return {
      id,
      templateId: template.id,
      name: previous?.name || template.name,
      description: previous?.description || template.description,
      systemPrompt: previous?.systemPrompt || applyIntentContext(template.systemPrompt, intentText),
      soul: previous?.soul || '',
      providerConfigId: configuredProvider?.id || null,
      setupProvider: configuredProvider?.setupProvider || null,
      provider: configuredProvider?.provider || null,
      model: shouldRefreshModel ? nextProviderDefault : previousModel,
      credentialId: configuredProvider?.credentialId || null,
      apiEndpoint: configuredProvider?.endpoint || null,
      gatewayProfileId: configuredProvider?.gatewayProfileId || null,
      tools: template.tools,
      capabilities: previous?.capabilities || template.capabilities || [],
      delegationEnabled: previous?.delegationEnabled ?? template.delegationEnabled ?? false,
      delegationTargetMode: previous?.delegationTargetMode || 'all',
      delegationTargetAgentIds: previous?.delegationTargetAgentIds || [],
      autoDraftSkillSuggestions: previous?.autoDraftSkillSuggestions ?? true,
      orchestratorEnabled: previous?.orchestratorEnabled ?? false,
      orchestratorMission: previous?.orchestratorMission || '',
      avatarSeed: previous?.avatarSeed || Math.random().toString(36).slice(2, 10),
      avatarUrl: previous?.avatarUrl || null,
      enabled: previous?.enabled ?? true,
    }
  })
}
