import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { loadCredentials, decryptKey, loadAgents, loadSettings } from './storage'
import { getProviderList } from '../providers'
import { normalizeOpenClawEndpoint } from '../openclaw-endpoint'

const OLLAMA_CLOUD_URL = 'https://ollama.com/v1'
const OLLAMA_LOCAL_URL = 'http://localhost:11434/v1'
const NON_LANGGRAPH_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])

/**
 * Build a LangChain chat model from provider config.
 * Uses the provider registry for endpoint defaults — no hardcoded provider list.
 * Anthropic is the only special case (different LangChain class); everything else is OpenAI-compatible.
 */
export function buildChatModel(opts: {
  provider: string
  model: string
  apiKey: string | null
  apiEndpoint?: string | null
}) {
  const { provider, model, apiKey, apiEndpoint } = opts
  const providers = getProviderList()
  const providerInfo = providers.find((p) => p.id === provider)
  const endpointRaw = apiEndpoint || providerInfo?.defaultEndpoint || null
  const endpoint = provider === 'openclaw'
    ? normalizeOpenClawEndpoint(endpointRaw)
    : endpointRaw

  if (provider === 'anthropic') {
    return new ChatAnthropic({
      model: model || 'claude-sonnet-4-6',
      anthropicApiKey: apiKey || undefined,
      maxTokens: 8192,
    })
  }

  if (provider === 'ollama') {
    const baseURL = apiKey && apiKey !== 'ollama'
      ? OLLAMA_CLOUD_URL
      : (endpoint ? `${endpoint}/v1` : OLLAMA_LOCAL_URL)
    return new ChatOpenAI({
      model: model || 'qwen3.5',
      apiKey: apiKey || 'ollama',
      configuration: { baseURL },
    })
  }

  // All other providers — OpenAI-compatible with their registered endpoint
  const config: any = { model: model || 'gpt-4o', apiKey: apiKey || undefined }
  if (endpoint) {
    config.configuration = { baseURL: endpoint }
    // OpenClaw endpoints behind Hostinger's proxy use express.json() middleware
    // which consumes the request body before http-proxy-middleware can forward it.
    // Sending as text/plain bypasses the body parser while the gateway still parses JSON.
    if (provider === 'openclaw') {
      config.configuration.defaultHeaders = { 'Content-Type': 'text/plain' }
    }
  }
  return config.configuration
    ? new ChatOpenAI(config)
    : new ChatOpenAI({ model: config.model, apiKey: config.apiKey })
}

function resolveApiKeyFromCredential(credentialId: string | null | undefined): string | null {
  if (!credentialId) return null
  const creds = loadCredentials()
  const cred = creds[credentialId]
  if (!cred?.encryptedKey) return null
  try {
    return decryptKey(cred.encryptedKey)
  } catch {
    return null
  }
}

/**
 * Build a LangChain LLM for generation tasks.
 * Priority:
 * 1) Settings -> Orchestrator Engine (if non-CLI provider configured)
 * 2) Default agent (must be non-CLI)
 */
export async function buildLLM() {
  const providers = getProviderList()
  const settings = loadSettings()

  const configuredProvider = typeof settings.langGraphProvider === 'string'
    ? settings.langGraphProvider.trim()
    : ''
  const hasConfiguredProvider = configuredProvider.length > 0 && !NON_LANGGRAPH_PROVIDER_IDS.has(configuredProvider)

  if (hasConfiguredProvider) {
    const providerInfo = providers.find((p) => p.id === configuredProvider)
    const model = (typeof settings.langGraphModel === 'string' && settings.langGraphModel.trim())
      ? settings.langGraphModel.trim()
      : providerInfo?.models?.[0] || ''
    const apiKey = resolveApiKeyFromCredential(settings.langGraphCredentialId)
    const apiEndpoint = (typeof settings.langGraphEndpoint === 'string' && settings.langGraphEndpoint.trim())
      ? settings.langGraphEndpoint.trim()
      : providerInfo?.defaultEndpoint || null

    if (providerInfo?.requiresApiKey && !apiKey) {
      throw new Error(`Orchestrator Engine provider "${providerInfo.name}" requires an API key. Configure one in Settings.`)
    }

    return {
      llm: buildChatModel({
        provider: configuredProvider,
        model,
        apiKey,
        apiEndpoint,
      }),
      provider: configuredProvider,
      model,
    }
  }

  const agents = loadAgents()
  const agent = agents.default as {
    provider?: string
    model?: string
    credentialId?: string | null
    apiEndpoint?: string | null
  } | undefined

  if (!agent) {
    throw new Error('Default agent not found. Configure Orchestrator Engine in Settings.')
  }

  if (!agent.provider || NON_LANGGRAPH_PROVIDER_IDS.has(agent.provider)) {
    throw new Error('Generate with AI requires a non-CLI provider. Configure Orchestrator Engine in Settings.')
  }

  const providerInfo = providers.find((p) => p.id === agent.provider)
  const model = (typeof agent.model === 'string' && agent.model.trim())
    ? agent.model.trim()
    : providerInfo?.models?.[0] || ''
  const apiKey = resolveApiKeyFromCredential(agent.credentialId)
  const apiEndpoint = agent.apiEndpoint || providerInfo?.defaultEndpoint || null

  if (providerInfo?.requiresApiKey && !apiKey) {
    throw new Error(`Default agent provider "${providerInfo.name}" requires an API key.`)
  }

  return {
    llm: buildChatModel({
      provider: agent.provider,
      model,
      apiKey,
      apiEndpoint: agent.apiEndpoint,
    }),
    provider: agent.provider as string,
    model,
  }
}
