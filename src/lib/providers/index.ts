import { streamClaudeCliChat } from './claude-cli'
import { streamOpenAiChat } from './openai'
import { streamOllamaChat } from './ollama'
import { streamAnthropicChat } from './anthropic'
import type { ProviderInfo, ProviderConfig as CustomProviderConfig } from '../../types'

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
    name: 'Claude CLI',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250514'],
    requiresApiKey: false,
    requiresEndpoint: false,
    handler: { streamChat: streamClaudeCliChat },
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

export function getProviderList(): ProviderInfo[] {
  const builtins = Object.values(PROVIDERS).map(({ handler, ...info }) => info)
  const customs = Object.values(getCustomProviders())
    .filter((c) => c.isEnabled)
    .map((c) => ({
      id: c.id as any,
      name: c.name,
      models: c.models,
      requiresApiKey: c.requiresApiKey,
      requiresEndpoint: false,
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
