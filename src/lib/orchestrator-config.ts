import type { Agent } from '@/types'

export const NON_ORCHESTRATOR_PROVIDERS = new Set([
  'claude-cli',
  'codex-cli',
  'opencode-cli',
  'openclaw',
  'hermes',
])

export type OrchestratorGovernance = 'autonomous' | 'approval-required' | 'notify-only'

export interface OrchestratorConfigInput {
  provider?: string | null
  orchestratorEnabled?: unknown
  orchestratorMission?: unknown
  orchestratorWakeInterval?: unknown
  orchestratorGovernance?: unknown
  orchestratorMaxCyclesPerDay?: unknown
}

export interface NormalizedOrchestratorConfig {
  orchestratorEnabled: boolean
  orchestratorMission?: string
  orchestratorWakeInterval: string | number | null
  orchestratorGovernance: OrchestratorGovernance
  orchestratorMaxCyclesPerDay: number | null
}

export function isOrchestratorProviderEligible(provider: string | null | undefined): boolean {
  return typeof provider === 'string' && provider.trim().length > 0 && !NON_ORCHESTRATOR_PROVIDERS.has(provider)
}

export function isOrchestratorEligible(agent: Pick<Agent, 'provider'> | null | undefined): boolean {
  return isOrchestratorProviderEligible(agent?.provider)
}

function normalizeWakeInterval(value: unknown): string | number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  return null
}

function normalizeGovernance(value: unknown): OrchestratorGovernance {
  return value === 'approval-required' || value === 'notify-only'
    ? value
    : 'autonomous'
}

function normalizeMaxCycles(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.trunc(value)
  return normalized > 0 ? normalized : null
}

export function normalizeOrchestratorConfig(input: OrchestratorConfigInput): NormalizedOrchestratorConfig {
  const mission = typeof input.orchestratorMission === 'string'
    ? input.orchestratorMission.trim()
    : ''

  return {
    orchestratorEnabled: input.orchestratorEnabled === true && isOrchestratorProviderEligible(input.provider),
    orchestratorMission: mission || undefined,
    orchestratorWakeInterval: normalizeWakeInterval(input.orchestratorWakeInterval),
    orchestratorGovernance: normalizeGovernance(input.orchestratorGovernance),
    orchestratorMaxCyclesPerDay: normalizeMaxCycles(input.orchestratorMaxCyclesPerDay),
  }
}
