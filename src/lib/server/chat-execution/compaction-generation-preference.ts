import type { GenerationModelPreference } from '@/lib/server/build-llm'
import type { AppSettings } from '@/types'

type CompactionGenerationSettings = Pick<AppSettings, 'compactionProvider' | 'compactionModel' | 'compactionCredentialId' | 'compactionEndpoint'> | Record<string, unknown> | null | undefined

function optionalSettingString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

/** Mirrors resolveDreamGenerationPreference — returns a model preference for
 *  the auto-compaction summarizer if app settings opt into a routing override,
 *  otherwise undefined (caller falls back to the session's primary model). */
export function resolveCompactionGenerationPreference(settings: CompactionGenerationSettings): GenerationModelPreference | undefined {
  const record = (settings || {}) as Record<string, unknown>
  const provider = optionalSettingString(record.compactionProvider)
  if (!provider) return undefined

  return {
    provider,
    model: optionalSettingString(record.compactionModel),
    credentialId: optionalSettingString(record.compactionCredentialId),
    apiEndpoint: optionalSettingString(record.compactionEndpoint),
  }
}
