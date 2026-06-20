export type ProviderType = 'claude-cli' | 'codex-cli' | 'opencode-cli' | 'opencode-web' | 'gemini-cli' | 'copilot-cli' | 'droid-cli' | 'cursor-cli' | 'qwen-code-cli' | 'goose' | 'aider-cli' | 'amp-cli' | 'augment-cli' | 'adal-cli' | 'bob-cli' | 'cline-cli' | 'codebuddy-cli' | 'command-code-cli' | 'continue-cli' | 'cortex-cli' | 'crush-cli' | 'deepagents-cli' | 'firebender-cli' | 'iflow-cli' | 'junie-cli' | 'kilo-code-cli' | 'kimi-cli' | 'kode-cli' | 'mcpjam-cli' | 'mistral-vibe-cli' | 'mux-cli' | 'neovate-cli' | 'openhands-cli' | 'pochi-cli' | 'qoder-cli' | 'replit-cli' | 'roo-code-cli' | 'trae-cn-cli' | 'warp-cli' | 'windsurf-cli' | 'zencoder-cli' | 'openai' | 'openrouter' | 'tokenmix' | 'ollama' | 'anthropic' | 'openclaw' | 'hermes' | 'lmstudio' | 'google' | 'deepseek' | 'groq' | 'together' | 'mistral' | 'xai' | 'fireworks' | 'nebius' | 'deepinfra'
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
  /** When true, shows an optional Base URL field in provider settings (e.g. for proxies). */
  optionalEndpoint?: boolean
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

export type ProviderDiagnosticStatus = 'pass' | 'warn' | 'fail'

export interface ProviderDiagnosticStep {
  id: string
  label: string
  status: ProviderDiagnosticStatus
  detail?: string
  target?: string
  durationMs?: number
}

export interface ProviderCheckResult {
  ok: boolean
  message: string
  normalizedEndpoint?: string
  recommendedModel?: string
  errorCode?: string
  deviceId?: string
  diagnostics?: ProviderDiagnosticStep[]
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
