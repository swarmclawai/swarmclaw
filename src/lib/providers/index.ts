import { streamClaudeCliChat } from './claude-cli'
import { streamCodexCliChat } from './codex-cli'
import { streamOpenCodeCliChat } from './opencode-cli'
import { streamOpenCodeWebChat } from './opencode-web'
import { streamGeminiCliChat } from './gemini-cli'
import { streamCopilotCliChat } from './copilot-cli'
import { streamDroidCliChat } from './droid-cli'
import { streamCursorCliChat } from './cursor-cli'
import { streamQwenCodeCliChat } from './qwen-code-cli'
import { streamGooseChat } from './goose'
import { streamOpenAiChat } from './openai'
import { streamOllamaChat } from './ollama'
import { streamAnthropicChat } from './anthropic'
import { streamOpenClawChat } from './openclaw'
import { errorMessage, sleep, jitteredBackoff } from '@/lib/shared-utils'
import { classifyProviderError } from './error-classification'
import { log } from '@/lib/server/logger'
import type { ProviderInfo, ProviderConfig as CustomProviderConfig, ProviderType, ProviderId } from '../../types'
import { loadProviderConfigs, loadModelOverrides, loadStoredItem, loadCredentials, decryptKey } from '@/lib/server/storage'
import { getExtensionManager } from '@/lib/server/extensions'

const TAG = 'providers'

export interface ProviderHandler {
  streamChat: (opts: StreamChatOptions) => Promise<string>
}

export interface StreamChatUsage {
  inputTokens: number
  outputTokens: number
}

export interface StreamChatOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: Record<string, any> & { id: string }
  message: string
  imagePath?: string
  imageUrl?: string
  apiKey?: string | null
  systemPrompt?: string
  write: (data: string) => void
  active: Map<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadHistory: (sessionId: string) => any[]
  onUsage?: (usage: StreamChatUsage) => void
  /** Abort signal from the caller — providers should use this to cancel in-flight requests. */
  signal?: AbortSignal
}

interface BuiltinProviderConfig extends ProviderInfo {
  handler: ProviderHandler
}

export const PROVIDERS: Record<string, BuiltinProviderConfig> = {
  'claude-cli': {
    id: 'claude-cli',
    name: 'Claude Code CLI',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamClaudeCliChat },
  },
  'codex-cli': {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    models: ['gpt-5.4-codex', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5-codex-mini'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamCodexCliChat },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3', 'o3-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    requiresApiKey: true,
    requiresEndpoint: false,
    optionalEndpoint: true,
    defaultEndpoint: 'https://api.openai.com/v1',
    handler: { streamChat: streamOpenAiChat },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [
      'openrouter/auto',
      'anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5',
      'openai/gpt-5.4', 'openai/gpt-5.4-mini',
      'google/gemini-3.1-pro', 'google/gemini-3-flash',
      'x-ai/grok-4',
      'deepseek/deepseek-v3.2',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://openrouter.ai/api/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    requiresApiKey: true,
    requiresEndpoint: false,
    optionalEndpoint: true,
    defaultEndpoint: 'https://api.anthropic.com',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.anthropic.com',
        }
        return streamAnthropicChat({ ...opts, session: patchedSession })
      },
    },
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    models: ['default'],
    requiresApiKey: false,
    optionalApiKey: true,
    requiresEndpoint: true,
    defaultEndpoint: 'http://localhost:18789',
    handler: { streamChat: streamOpenClawChat },
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes Agent',
    models: ['hermes-agent'],
    requiresApiKey: false,
    optionalApiKey: true,
    requiresEndpoint: true,
    defaultEndpoint: 'http://127.0.0.1:8642/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'http://127.0.0.1:8642/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  'opencode-cli': {
    id: 'opencode-cli',
    name: 'OpenCode CLI',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-5.4', 'gemini-3.1-pro', 'gemini-3-flash'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamOpenCodeCliChat },
  },
  'opencode-web': {
    id: 'opencode-web',
    name: 'OpenCode Web',
    // OpenCode addresses models as `providerID/modelID`. Free-text entry is
    // supported; these defaults seed the dropdown with common combinations.
    models: [
      'anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5',
      'openai/gpt-5.4', 'openai/gpt-5.4-mini',
      'google/gemini-3.1-pro', 'google/gemini-3-flash',
    ],
    requiresApiKey: false,
    optionalApiKey: true,
    requiresEndpoint: true,
    defaultEndpoint: 'http://localhost:4096',
    handler: { streamChat: streamOpenCodeWebChat },
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    models: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamGeminiCliChat },
  },
  'copilot-cli': {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    models: ['claude-sonnet-4-6', 'gpt-5.4', 'gemini-3.1-pro'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamCopilotCliChat },
  },
  'droid-cli': {
    id: 'droid-cli',
    name: 'Factory Droid CLI',
    models: ['default'],
    requiresApiKey: false,
    optionalApiKey: true,
    requiresEndpoint: false,
    handler: { streamChat: streamDroidCliChat },
  },
  'cursor-cli': {
    id: 'cursor-cli',
    name: 'Cursor Agent CLI',
    models: ['auto'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamCursorCliChat },
  },
  'qwen-code-cli': {
    id: 'qwen-code-cli',
    name: 'Qwen Code CLI',
    models: ['default'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamQwenCodeCliChat },
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    models: ['default'],
    requiresApiKey: false,
    optionalApiKey: true,
    requiresEndpoint: false,
    handler: { streamChat: streamGooseChat },
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    models: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://generativelanguage.googleapis.com/v1beta/openai',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    // Stable aliases: 'deepseek-chat' is the non-thinking mode of the latest
    // V-series (currently V3.2), 'deepseek-reasoner' is the thinking mode.
    // DeepSeek rotates the underlying weights without changing these names.
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.deepseek.com/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.deepseek.com/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    models: [
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'moonshotai/kimi-k2-instruct-0905',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.groq.com/openai/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  together: {
    id: 'together',
    name: 'Together AI',
    models: [
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      'deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-235B-A22B-Instruct',
      'moonshotai/Kimi-K2-Instruct-0905',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.together.xyz/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.together.xyz/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    models: [
      'magistral-medium-1.2',
      'magistral-small-1.2',
      'devstral-medium',
      'devstral-small-1.1',
      'codestral-latest',
      'mistral-small-4',
      'mistral-large-latest',
      'ministral-3b-latest',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.mistral.ai/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.mistral.ai/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    models: ['grok-4', 'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning', 'grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning'],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.x.ai/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.x.ai/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks AI',
    models: [
      'accounts/fireworks/models/deepseek-v3p2',
      'accounts/fireworks/models/kimi-k2-instruct-0905',
      'accounts/fireworks/models/glm-5',
      'accounts/fireworks/models/qwen3-235b-a22b',
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.fireworks.ai/inference/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.fireworks.ai/inference/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  nebius: {
    id: 'nebius',
    name: 'Nebius',
    models: [
      'deepseek-ai/DeepSeek-V3.2',
      'moonshotai/Kimi-K2-Instruct',
      'Qwen/Qwen3-235B-A22B',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'deepseek-ai/DeepSeek-R1',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.tokenfactory.nebius.com/v1',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.tokenfactory.nebius.com/v1',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  deepinfra: {
    id: 'deepinfra',
    name: 'DeepInfra',
    models: [
      'deepseek-ai/DeepSeek-V3.2',
      'moonshotai/Kimi-K2-Instruct',
      'Qwen/Qwen3-235B-A22B',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'deepseek-ai/DeepSeek-R1',
    ],
    requiresApiKey: true,
    requiresEndpoint: false,
    defaultEndpoint: 'https://api.deepinfra.com/v1/openai',
    handler: {
      streamChat: (opts) => {
        const patchedSession = {
          ...opts.session,
          apiEndpoint: opts.session.apiEndpoint || 'https://api.deepinfra.com/v1/openai',
        }
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    models: [
      'qwen3.5', 'qwen3-coder-next', 'qwen3-coder', 'qwen3-next', 'qwen3-vl',
      'glm-5', 'glm-4.7', 'glm-4.6',
      'kimi-k2.5', 'kimi-k2', 'kimi-k2-thinking',
      'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
      'deepseek-v3.2', 'deepseek-r1',
      'gemini-3-flash-preview', 'gemma3',
      'devstral-2', 'devstral-small-2', 'ministral-3', 'mistral-large-3',
      'gpt-oss', 'cogito-2.1', 'rnj-1', 'nemotron-3-nano',
      'llama3.3', 'llama3.2',
    ],
    requiresApiKey: false,
    optionalApiKey: true,
    requiresEndpoint: true,
    defaultEndpoint: 'http://localhost:11434',
    handler: { streamChat: streamOllamaChat },
  },
}

/** Merge built-in providers with custom providers from storage */
function getCustomProviders(): Record<string, CustomProviderConfig> {
  try {
    const configs = loadProviderConfigs() as Record<string, CustomProviderConfig>
    return Object.fromEntries(
      Object.entries(configs).filter(([, config]) => config?.type === 'custom'),
    )
  } catch (err) {
    log.warn(TAG, 'Failed to load custom providers from storage', errorMessage(err))
    return {}
  }
}

function getModelOverrides(): Record<string, string[]> {
  try {
    return loadModelOverrides()
  } catch {
    return {}
  }
}

export function getProviderList(): ProviderInfo[] {
  const overrides = getModelOverrides()
  const builtins = Object.values(PROVIDERS)
    .filter(({ id }) => id !== 'openclaw')
    .map((provider) => {
      const { handler, ...info } = provider
      void handler
      return {
        ...info,
        models: overrides[info.id] || info.models,
        defaultModels: info.models,
        supportsModelDiscovery: !['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'droid-cli', 'cursor-cli', 'qwen-code-cli', 'goose', 'fireworks'].includes(info.id),
      }
    })
  
  const customs: ProviderInfo[] = Object.values(getCustomProviders())
    .filter((c) => c.isEnabled)
    .map((c) => ({
      id: c.id as ProviderId,
      name: c.name,
      models: c.models,
      defaultModels: c.models,
      supportsModelDiscovery: false,
      requiresApiKey: c.requiresApiKey,
      optionalApiKey: !c.requiresApiKey,
      requiresEndpoint: false as boolean,
      defaultEndpoint: c.baseUrl,
    }))

  let extensionProviders: ProviderInfo[] = []
  try {
    extensionProviders = getExtensionManager().getProviders().map((p) => ({
      id: p.id as ProviderId,
      name: p.name,
      models: p.models,
      defaultModels: p.models,
      supportsModelDiscovery: false,
      requiresApiKey: p.requiresApiKey,
      requiresEndpoint: p.requiresEndpoint,
      defaultEndpoint: p.defaultEndpoint,
    }))
  } catch { /* ignore if running somewhere extensions aren't available */ }

  return [...builtins, ...customs, ...extensionProviders]
}

function buildCustomProviderConfig(custom: CustomProviderConfig): BuiltinProviderConfig {
  return {
    id: custom.id as ProviderId,
    name: custom.name,
    models: custom.models,
    requiresApiKey: custom.requiresApiKey,
    optionalApiKey: !custom.requiresApiKey,
    requiresEndpoint: false,
    defaultEndpoint: custom.baseUrl,
    handler: {
      streamChat: async (opts) => {
        const patchedSession = { ...opts.session, apiEndpoint: custom.baseUrl }
        const { streamOpenAiChat } = await import('./openai')
        return streamOpenAiChat({ ...opts, session: patchedSession })
      },
    },
  }
}

export function getProvider(id: string): BuiltinProviderConfig | null {
  // Check builtin providers — inject custom baseUrl from provider config if set
  const builtin = PROVIDERS[id]
  if (builtin) {
    const pConfigs = loadProviderConfigs()
    const pConfig = pConfigs[id]
    if (pConfig?.baseUrl && pConfig.baseUrl !== builtin.defaultEndpoint) {
      const originalHandler = builtin.handler
      return {
        ...builtin,
        handler: {
          streamChat: (opts) => {
            const patchedSession = {
              ...opts.session,
              apiEndpoint: opts.session.apiEndpoint || pConfig.baseUrl,
            }
            return originalHandler.streamChat({ ...opts, session: patchedSession })
          },
        },
      }
    }
    return builtin
  }

  // Check custom providers
  const customs = getCustomProviders()
  const custom = customs[id]
  if (custom?.isEnabled) {
    return buildCustomProviderConfig(custom)
  }

  // Fallback: direct single-item DB lookup for custom-* providers
  if (id.startsWith('custom-') && !custom) {
    try {
      const directConfig = loadStoredItem('provider_configs', id) as CustomProviderConfig | null
      if (directConfig?.type === 'custom' && directConfig.isEnabled) {
        log.info(TAG, `Resolved custom provider '${id}' via direct DB lookup (batch load missed it)`)
        return buildCustomProviderConfig(directConfig)
      }
    } catch (err) {
      log.warn(TAG, `Direct DB lookup failed for provider '${id}'`, errorMessage(err))
    }
  }

  // Check Extension Providers
  try {
    const extensionProviders = getExtensionManager().getProviders()
    const found = extensionProviders.find((p) => p.id === id)
    if (found) {
      return {
        id: found.id as ProviderId,
        name: found.name,
        models: found.models,
        requiresApiKey: found.requiresApiKey,
        requiresEndpoint: found.requiresEndpoint,
        handler: {
          streamChat: found.streamChat
        }
      }
    }
  } catch { /* ignore */ }

  return null
}

/**
 * Stream chat with automatic failover to fallback credentials on retryable errors.
 * Falls back through fallbackCredentialIds on 401/429/500/502/503 errors.
 */
export async function streamChatWithFailover(
  opts: StreamChatOptions & { fallbackCredentialIds?: string[] },
): Promise<string> {
  const provider = getProvider(opts.session.provider)
  if (!provider) throw new Error(`Unknown provider: ${opts.session.provider}`)

  const credentialIds = [
    opts.session.credentialId,
    ...(opts.fallbackCredentialIds || []),
  ].filter(Boolean) as string[]

  // If no fallbacks, just call directly
  if (credentialIds.length <= 1) {
    return provider.handler.streamChat(opts)
  }

  let lastError: unknown = null

  for (let i = 0; i < credentialIds.length; i++) {
    const credId = credentialIds[i]
    try {
      // Resolve API key for this credential
      let apiKey: string | null = opts.apiKey || null
      if (credId && i > 0) {
        // Need to decrypt fallback credential
        const creds = loadCredentials()
        const cred = creds[credId]
        if (cred?.encryptedKey) {
          try { apiKey = decryptKey(cred.encryptedKey) } catch { /* skip */ }
        }
      }

      const result = await provider.handler.streamChat({
        ...opts,
        apiKey,
      })
      return result // success
    } catch (err: unknown) {
      lastError = err
      const classified = classifyProviderError(err)
      const errMessage = errorMessage(err)
      if (!classified.retryable && classified.reason !== 'auth') throw err
      if (classified.reason === 'auth_permanent') throw err

      if (i < credentialIds.length - 1) {
        log.info(TAG, `Credential ${credId} failed (${classified.reason}: ${errMessage?.slice(0, 80)}), trying fallback...`)
        opts.write(`data: ${JSON.stringify({
          t: 'md',
          text: JSON.stringify({ failover: { from: credId, reason: errMessage?.slice(0, 100) } }),
        })}\n\n`)
        if (classified.reason !== 'auth') {
          await sleep(classified.suggestedBackoffMs || jitteredBackoff(500, i, 8000))
        }
        continue
      }
      throw err
    }
  }

  throw lastError || new Error('All credentials exhausted')
}
