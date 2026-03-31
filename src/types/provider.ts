export type ProviderType = 'claude-cli' | 'codex-cli' | 'opencode-cli' | 'gemini-cli' | 'copilot-cli' | 'openai' | 'ollama' | 'anthropic' | 'openclaw' | 'google' | 'deepseek' | 'groq' | 'together' | 'mistral' | 'xai' | 'fireworks' | 'nebius' | 'deepinfra'
export type ProviderId = ProviderType | (string & {})

export interface ProviderInfo {
  id: ProviderId
  name: string
  models: string[]
  defaultModels?: string[]
  supportsModelDiscovery?: boolean
  requiresApiKey: boolean
  optionalApiKey?: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
}

export interface ProviderModelDiscoveryResult {
  ok: boolean
  providerId: string
  providerName?: string
  models: string[]
  cached: boolean
  fetchedAt: number
  cacheTtlMs: number
  supportsDiscovery: boolean
  missingCredential?: boolean
  message?: string
}

export interface Credential {
  id: string
  provider: string
  name: string
  createdAt: number
}

export type Credentials = Record<string, Credential>
export type OllamaMode = 'local' | 'cloud'

// --- Custom Providers ---

export interface ProviderConfig {
  id: string
  name: string
  type: 'builtin' | 'custom'
  baseUrl?: string
  models: string[]
  requiresApiKey: boolean
  credentialId?: string | null
  isEnabled: boolean
  createdAt: number
  updatedAt: number
}
