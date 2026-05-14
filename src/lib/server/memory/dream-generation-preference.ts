import type { GenerationModelPreference } from '@/lib/server/build-llm'
import type { AppSettings, DreamConfig } from '@/types'

type DreamGenerationSettings = Pick<AppSettings, 'dreamProvider' | 'dreamModel' | 'dreamCredentialId' | 'dreamEndpoint'> | Record<string, unknown> | null | undefined

type DreamConfigOverride = Pick<DreamConfig, 'provider' | 'model' | 'credentialId' | 'endpoint'> | Partial<DreamConfig> | Record<string, unknown> | null | undefined

function optionalSettingString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

/**
 * Resolve which model to use for memory consolidation / dream cycles.
 *
 * Precedence:
 *   1. Per-agent override (`dreamConfig.provider` on the Agent record)
 *   2. Global app settings (`dreamProvider` etc.)
 *   3. undefined — caller falls back to the agent's primary generation model
 *
 * The per-agent override lets you route different agents to different dream
 * models (e.g. cheap local for most, but a stronger model for an agent whose
 * memory mix needs more capable structured-output generation).
 */
export function resolveDreamGenerationPreference(
  settings: DreamGenerationSettings,
  override?: DreamConfigOverride,
): GenerationModelPreference | undefined {
  const overrideRecord = (override || {}) as Record<string, unknown>
  const overrideProvider = optionalSettingString(overrideRecord.provider)
  if (overrideProvider) {
    return {
      provider: overrideProvider,
      model: optionalSettingString(overrideRecord.model),
      credentialId: optionalSettingString(overrideRecord.credentialId),
      apiEndpoint: optionalSettingString(overrideRecord.endpoint),
    }
  }

  const record = (settings || {}) as Record<string, unknown>
  const provider = optionalSettingString(record.dreamProvider)
  if (!provider) return undefined

  return {
    provider,
    model: optionalSettingString(record.dreamModel),
    credentialId: optionalSettingString(record.dreamCredentialId),
    apiEndpoint: optionalSettingString(record.dreamEndpoint),
  }
}
