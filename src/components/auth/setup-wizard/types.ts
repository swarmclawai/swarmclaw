import type { GatewayProfile } from '@/types'
import type { SetupProvider, StarterKitAgentTemplate } from '@/lib/setup-defaults'

export type SetupStep = 'profile' | 'providers' | 'connect' | 'agents' | 'next' | 'done'
export type CheckState = 'idle' | 'checking' | 'ok' | 'error'

export interface ProviderCheckResponse {
  ok: boolean
  message: string
  normalizedEndpoint?: string
  recommendedModel?: string
  errorCode?: string
  deviceId?: string
}

export interface SetupDoctorCheck {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
  required?: boolean
}

export interface SetupDoctorResponse {
  ok: boolean
  summary: string
  checks: SetupDoctorCheck[]
  actions?: string[]
}

export interface SetupWizardProps {
  onComplete: () => void
}

export interface ConfiguredProvider {
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
  verified?: boolean
}

export interface StarterDraftAgent {
  id: string
  templateId: string
  name: string
  description: string
  systemPrompt: string
  soul: string
  providerConfigId: string | null
  provider: SetupProvider | null
  model: string
  credentialId: string | null
  apiEndpoint: string | null
  gatewayProfileId: string | null
  tools: string[]
  capabilities: string[]
  platformAssignScope: 'self' | 'all'
  avatarSeed: string
  avatarUrl: string | null
  enabled: boolean
}

export interface CreatedAgentSummary {
  id: string
  name: string
  provider: SetupProvider
  providerName: string
}

export const STEP_ORDER: SetupStep[] = ['profile', 'providers', 'agents']

export const CONNECTOR_ICONS = [
  { name: 'Discord', icon: 'D' },
  { name: 'Slack', icon: 'S' },
  { name: 'Telegram', icon: 'T' },
  { name: 'WhatsApp', icon: 'W' },
]

export const OPENCLAW_USE_CASE_LABELS: Record<NonNullable<NonNullable<GatewayProfile['deployment']>['useCase']>, string> = {
  'local-dev': 'Local Dev',
  'single-vps': 'Single VPS',
  'private-tailnet': 'Private Tailnet',
  'browser-heavy': 'Browser Heavy',
  'team-control': 'Team Control',
}

export const OPENCLAW_EXPOSURE_LABELS: Record<NonNullable<NonNullable<GatewayProfile['deployment']>['exposure']>, string> = {
  'private-lan': 'Private LAN',
  tailscale: 'Tailscale',
  caddy: 'Caddy',
  nginx: 'Nginx',
  'ssh-tunnel': 'SSH Tunnel',
}

/** Shared props passed from facade to each step */
export interface StepProvidersProps {
  configuredProviders: ConfiguredProvider[]
  configuredProviderIds: Set<SetupProvider>
  error: string
  canContinue: boolean
  onSelectProvider: (provider: SetupProvider) => void
  onRemoveProvider: (id: string) => void
  onContinue: () => void
  onSkip: () => void
}

export interface StepConnectProps {
  provider: SetupProvider
  selectedProvider: import('@/lib/setup-defaults').SetupProviderOption
  initialLabel: string
  editingProvider: ConfiguredProvider | null
  configuredProviders: ConfiguredProvider[]
  starterKitId: string | null
  intentText: string
  onSaveProvider: (provider: ConfiguredProvider) => void
  onBack: () => void
  onSkip: () => void
}

export interface StepAgentsProps {
  draftAgents: StarterDraftAgent[]
  configuredProviders: ConfiguredProvider[]
  saving: boolean
  error: string
  onUpdateDraft: (id: string, patch: Partial<StarterDraftAgent>) => void
  onUpdateDraftProvider: (id: string, providerConfigId: string) => void
  onSaveAndContinue: () => void
  onRemoveAgent: (id: string) => void
  onBack: () => void
  onSkip: () => void
}

export interface StepNextProps {
  onAddProvider: () => void
  onAddAgent: () => void
  onContinueToDashboard: () => void
}

export interface StepDoneProps {
  createdAgents: CreatedAgentSummary[]
  onComplete: () => void
}
