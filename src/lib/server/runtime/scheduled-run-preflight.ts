import { getProvider } from '@/lib/providers'
import { resolveCredentialSecret } from '@/lib/server/credentials/credential-service'
import { resolveProviderCredentialId } from '@/lib/server/provider-endpoint'

export interface ProviderCredentialPreflightInput {
  provider?: string | null
  ollamaMode?: string | null
  credentialId?: string | null
  fallbackCredentialIds?: readonly string[] | null
}

export interface ProviderCredentialPreflightDeps {
  getProvider: (id: string) => { requiresApiKey?: boolean } | null
  resolveProviderCredentialId: (input: {
    provider?: string | null
    ollamaMode?: string | null
    credentialId?: string | null
  }) => string | null
  resolveCredentialSecret: (credentialId: string | null | undefined) => string | null
}

export type ProviderCredentialPreflightResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Fail-fast credential check for scheduled runs. Catches the "schedule fires
 * deep into execution and dies on a 401" case before the run starts. No
 * network calls: it only verifies that at least one credential with a
 * decryptable secret exists for a provider that requires an API key.
 *
 * Deliberately permissive: it passes whenever ANY candidate credential
 * resolves, so it can only block runs that are guaranteed to fail.
 */
export function preflightProviderCredential(
  input: ProviderCredentialPreflightInput,
  deps?: Partial<ProviderCredentialPreflightDeps>,
): ProviderCredentialPreflightResult {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  if (!provider) return { ok: true }

  const resolved: ProviderCredentialPreflightDeps = {
    getProvider,
    resolveProviderCredentialId,
    resolveCredentialSecret,
    ...deps,
  }

  let providerConfig: { requiresApiKey?: boolean } | null = null
  try {
    providerConfig = resolved.getProvider(provider)
  } catch {
    return { ok: true }
  }
  // Unknown/custom providers and key-optional providers (ollama, CLI, gateway
  // routes) are exempt; execution resolves those credentials differently.
  if (providerConfig?.requiresApiKey !== true) return { ok: true }

  const candidateIds = [
    resolved.resolveProviderCredentialId({
      provider,
      ollamaMode: input.ollamaMode ?? null,
      credentialId: input.credentialId ?? null,
    }),
    ...(input.fallbackCredentialIds || []),
    // Last resort: any credential stored for this provider
    input.credentialId
      ? resolved.resolveProviderCredentialId({ provider, ollamaMode: input.ollamaMode ?? null, credentialId: null })
      : null,
  ]
  const seen = new Set<string>()
  for (const candidateId of candidateIds) {
    const id = typeof candidateId === 'string' ? candidateId.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (resolved.resolveCredentialSecret(id)) return { ok: true }
  }

  return {
    ok: false,
    error: `Provider authentication preflight failed: no API credential configured for provider "${provider}". Add a key in Settings > Providers (or assign one to the agent), then re-run the schedule.`,
  }
}
