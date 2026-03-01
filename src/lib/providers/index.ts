import { streamClaudeCliChat } from './claude-cli'
import { streamCodexCliChat } from './codex-cli'
import { streamOpenCodeCliChat } from './opencode-cli'
import { streamOpenAiChat } from './openai'
import { streamOllamaChat } from './ollama'
import { streamAnthropicChat } from './anthropic'
import { streamOpenClawChat } from './openclaw'
import type { ProviderInfo, ProviderConfig as CustomProviderConfig } from '../../types'

const RETRYABLE_STATUS_CODES = [401, 429, 500, 502, 503]

export interface ProviderHandler {
  streamChat: (opts: StreamChatOptions) => Promise<string>
}

export interface StreamChatOptions {
  session: any
  message: string
  imagePath?: string
  apiKey?: string | null
  systemPrompt?: string
  write: (data: string) => void
  active: Map<string, any>
  loadHistory: (sessionId: string) => any[]
}

interface BuiltinProviderConfig extends ProviderInfo {
  handler: ProviderHandler
}

const PROVIDERS: Record<string, BuiltinProviderConfig> = {
  'claude-cli': {
    id: 'claude-cli',
    name: 'Claude Code CLI',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250514'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamClaudeCliChat },
  },
  'codex-cli': {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    models: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5-codex-mini'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamCodexCliChat },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o3-mini', 'o4-mini'],
    requiresApiKey: true,
    requiresEndpoint: false,
    handler: { streamChat: streamOpenAiChat },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    requiresApiKey: true,
    requiresEndpoint: false,
    handler: { streamChat: streamAnthropicChat },
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
  'opencode-cli': {
    id: 'opencode-cli',
    name: 'OpenCode CLI',
    models: ['claude-sonnet-4-6', 'gpt-4.1', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamOpenCodeCliChat },
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
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
    models: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'qwen-qwq-32b', 'gemma2-9b-it'],
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
    models: ['meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
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
    models: ['mistral-large-latest', 'mistral-small-latest', 'magistral-medium-2506', 'devstral-small-latest'],
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
    models: ['grok-3', 'grok-3-fast', 'grok-3-mini', 'grok-3-mini-fast'],
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
    models: ['accounts/fireworks/models/deepseek-r1-0528', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen3-235b-a22b'],
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
      'llama3.3', 'llama3.2', 'llama3.1',
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
    const { loadProviderConfigs } = require('../server/storage')
    return loadProviderConfigs() as Record<string, CustomProviderConfig>
  } catch {
    return {}
  }
}

function getModelOverrides(): Record<string, string[]> {
  try {
    const { loadModelOverrides } = require('../server/storage')
    return loadModelOverrides()
  } catch {
    return {}
  }
}

export function getProviderList(): ProviderInfo[] {
  const overrides = getModelOverrides()
  const builtins = Object.values(PROVIDERS)
    .filter(({ id }) => id !== 'openclaw')
    .map(({ handler, ...info }) => ({
      ...info,
      models: overrides[info.id] || info.models,
      defaultModels: info.models,
    }))
  const customs = Object.values(getCustomProviders())
    .filter((c) => c.isEnabled)
    .map((c) => ({
      id: c.id as any,
      name: c.name,
      models: c.models,
      defaultModels: c.models,
      requiresApiKey: c.requiresApiKey,
      requiresEndpoint: false,
      defaultEndpoint: c.baseUrl,
    }))
  return [...builtins, ...customs]
}

export function getProvider(id: string): BuiltinProviderConfig | null {
  if (PROVIDERS[id]) return PROVIDERS[id]
  // Check custom providers — they use OpenAI-compatible handler with custom baseUrl
  const customs = getCustomProviders()
  const custom = customs[id]
  if (custom?.isEnabled) {
    return {
      id: custom.id as any,
      name: custom.name,
      models: custom.models,
      requiresApiKey: custom.requiresApiKey,
      requiresEndpoint: false,
      handler: {
        streamChat: (opts) => {
          // Custom providers use OpenAI handler with custom baseUrl
          const patchedSession = { ...opts.session, apiEndpoint: custom.baseUrl }
          return streamOpenAiChat({ ...opts, session: patchedSession })
        },
      },
    }
  }
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

  let lastError: any = null

  for (let i = 0; i < credentialIds.length; i++) {
    const credId = credentialIds[i]
    try {
      // Resolve API key for this credential
      let apiKey: string | null = opts.apiKey || null
      if (credId && i > 0) {
        // Need to decrypt fallback credential
        const { loadCredentials, decryptKey } = require('../server/storage')
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
    } catch (err: any) {
      lastError = err
      const statusCode = err.status || err.statusCode || 0
      const isRetryable = RETRYABLE_STATUS_CODES.includes(statusCode)
        || err.message?.includes('rate limit')
        || err.message?.includes('Rate limit')
        || err.message?.includes('429')
        || err.message?.includes('401')

      if (isRetryable && i < credentialIds.length - 1) {
        console.log(`[failover] Credential ${credId} failed (${statusCode || err.message}), trying fallback...`)
        // Send a metadata event to inform the client
        opts.write(`data: ${JSON.stringify({
          t: 'md',
          text: JSON.stringify({ failover: { from: credId, reason: err.message?.slice(0, 100) } }),
        })}\n\n`)
        continue
      }
      throw err
    }
  }

  throw lastError || new Error('All credentials exhausted')
}
