import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { getProviderList } from '../providers'
import { normalizeOpenClawEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { NON_LANGGRAPH_PROVIDER_IDS } from '../provider-sets'
import { resolveOllamaRuntimeConfig } from './ollama-runtime'
import { resolveProviderApiEndpoint, resolveProviderCredentialId } from './provider-endpoint'
import { getAgent } from './agents/agent-repository'
import { resolveCredentialSecret } from './credentials/credential-service'
import { getSession } from './sessions/session-repository'
import type { Agent } from '@/types'

const OLLAMA_CLOUD_URL = 'https://ollama.com/v1'
const OLLAMA_LOCAL_URL = 'http://localhost:11434/v1'
export const OPENAI_COMPAT_MODEL_TIMEOUT_MS = 180_000
export const OPENAI_COMPAT_MODEL_MAX_RETRIES = 2

export interface GenerationModelPreference {
  provider?: string | null
  model?: string | null
  ollamaMode?: 'local' | 'cloud' | null
  credentialId?: string | null
  apiEndpoint?: string | null
  gatewayProfileId?: string | null
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | null
}

interface ResolvedGenerationModelConfig {
  provider: string
  model: string
  ollamaMode?: 'local' | 'cloud'
  apiKey: string | null
  apiEndpoint: string | null
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
}

type OpenAiReasoningEffort = 'low' | 'medium' | 'high'
type ChatOpenAiConfig = ConstructorParameters<typeof ChatOpenAI>[0] & {
  modelKwargs?: {
    reasoning_effort?: OpenAiReasoningEffort
  }
  configuration?: {
    baseURL?: string
    defaultHeaders?: Record<string, string>
  }
}

function toOpenAiCompatibleBaseUrl(endpoint: string | null | undefined, fallback: string): string {
  const normalized = (endpoint || fallback).replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

/**
 * Build a LangChain chat model from provider config.
 * Uses the provider registry for endpoint defaults — no hardcoded provider list.
 * Anthropic is the only special case (different LangChain class); everything else is OpenAI-compatible.
 */
export function buildChatModel(opts: {
  provider: string
  model: string
  ollamaMode?: 'local' | 'cloud' | null
  apiKey: string | null
  credentialId?: string | null
  apiEndpoint?: string | null
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
}) {
  const { provider, model, ollamaMode, apiKey, credentialId, apiEndpoint, thinkingLevel } = opts
  const resolvedCredentialId = resolveProviderCredentialId({ provider, ollamaMode: ollamaMode ?? null, credentialId })
  const resolvedApiKey = apiKey ?? resolveApiKeyFromCredential(resolvedCredentialId)
  const providers = getProviderList()
  const providerInfo = providers.find((p) => p.id === provider)
  const endpointRaw = apiEndpoint || providerInfo?.defaultEndpoint || null
  const endpoint = provider === 'openclaw'
    ? normalizeOpenClawEndpoint(endpointRaw)
    : endpointRaw

  if (provider === 'anthropic') {
    const anthropicOpts: Record<string, unknown> = {
      model: model || 'claude-sonnet-4-6',
      anthropicApiKey: resolvedApiKey || undefined,
      maxTokens: 8192,
      maxRetries: OPENAI_COMPAT_MODEL_MAX_RETRIES,
    }
    if (thinkingLevel) {
      const budgetMap = { minimal: 1024, low: 4096, medium: 8192, high: 16384 }
      anthropicOpts.thinking = { type: 'enabled', budget_tokens: budgetMap[thinkingLevel] }
      // Extended thinking requires higher maxTokens (budget + output)
      anthropicOpts.maxTokens = budgetMap[thinkingLevel] + 8192
    }
    return new ChatAnthropic(anthropicOpts as ConstructorParameters<typeof ChatAnthropic>[0])
  }

  if (provider === 'ollama') {
    const runtime = resolveOllamaRuntimeConfig({ model, ollamaMode, apiKey: resolvedApiKey, apiEndpoint })
    if (runtime.useCloud && !runtime.apiKey) {
      throw new Error('Ollama Cloud model requires an API key. Set OLLAMA_API_KEY or attach an Ollama credential.')
    }
    const baseURL = runtime.useCloud
      ? OLLAMA_CLOUD_URL
      : toOpenAiCompatibleBaseUrl(runtime.endpoint, OLLAMA_LOCAL_URL)
    return new ChatOpenAI({
      model: runtime.model || 'qwen3.5',
      apiKey: runtime.useCloud ? runtime.apiKey || undefined : runtime.apiKey || 'ollama',
      timeout: OPENAI_COMPAT_MODEL_TIMEOUT_MS,
      maxRetries: OPENAI_COMPAT_MODEL_MAX_RETRIES,
      configuration: { baseURL },
    })
  }

  // All other providers — OpenAI-compatible with their registered endpoint
  const config: ChatOpenAiConfig = {
    model: model || 'gpt-4o',
    apiKey: resolvedApiKey || undefined,
    timeout: OPENAI_COMPAT_MODEL_TIMEOUT_MS,
    maxRetries: OPENAI_COMPAT_MODEL_MAX_RETRIES,
  }
  // Map thinking level to reasoning_effort for OpenAI o-series models
  if (thinkingLevel && provider === 'openai' && /^o\d/.test(model || '')) {
    const effortMap: Record<NonNullable<typeof thinkingLevel>, OpenAiReasoningEffort> = {
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
    }
    config.modelKwargs = { reasoning_effort: effortMap[thinkingLevel] }
  }
  if (endpoint) {
    config.configuration = { baseURL: endpoint }
    // OpenClaw endpoints behind Hostinger's proxy use express.json() middleware
    // which consumes the request body before http-proxy-middleware can forward it.
    // Sending as text/plain bypasses the body parser while the gateway still parses JSON.
    if (provider === 'openclaw') {
      config.configuration.defaultHeaders = { 'Content-Type': 'text/plain' }
    }
  }
  return new ChatOpenAI(config)
}

function resolveApiKeyFromCredential(credentialId: string | null | undefined): string | null {
  return resolveCredentialSecret(credentialId)
}

function normalizePreferenceValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getAgentGenerationPreferences(agent: Agent | null | undefined): GenerationModelPreference[] {
  if (!agent) return []
  const preferences: GenerationModelPreference[] = [{
    provider: agent.provider,
    model: agent.model,
    ollamaMode: agent.ollamaMode || null,
    credentialId: agent.credentialId || null,
    apiEndpoint: agent.apiEndpoint || null,
    gatewayProfileId: agent.gatewayProfileId || null,
    thinkingLevel: agent.thinkingLevel || null,
  }]
  const routingTargets = Array.isArray(agent.routingTargets)
    ? [...agent.routingTargets].sort((a, b) => (a.priority || Number.MAX_SAFE_INTEGER) - (b.priority || Number.MAX_SAFE_INTEGER))
    : []
  for (const target of routingTargets) {
    preferences.push({
      provider: target.provider,
      model: target.model,
      ollamaMode: target.ollamaMode || null,
      credentialId: target.credentialId || null,
      apiEndpoint: target.apiEndpoint || null,
      gatewayProfileId: target.gatewayProfileId || null,
      thinkingLevel: agent.thinkingLevel || null,
    })
  }
  return preferences
}

function resolvePreferredGenerationConfig(
  providers: ReturnType<typeof getProviderList>,
  preferred: GenerationModelPreference | GenerationModelPreference[] | undefined,
  excludeProviders: Set<string>,
): ResolvedGenerationModelConfig | null {
  const candidates = Array.isArray(preferred) ? preferred : preferred ? [preferred] : []
  for (const candidate of candidates) {
    const provider = normalizePreferenceValue(candidate.provider)
    if (!provider || NON_LANGGRAPH_PROVIDER_IDS.has(provider) || excludeProviders.has(provider)) continue
    const providerInfo = providers.find((entry) => entry.id === provider)
    const model = normalizePreferenceValue(candidate.model) || providerInfo?.models?.[0] || ''
    const credentialId = resolveProviderCredentialId({
      provider,
      ollamaMode: candidate.ollamaMode || null,
      credentialId: candidate.credentialId,
    })
    const apiKey = resolveApiKeyFromCredential(credentialId)
    const apiEndpoint = resolveProviderApiEndpoint({
      provider,
      model,
      ollamaMode: candidate.ollamaMode || null,
      credentialId,
      apiEndpoint: normalizePreferenceValue(candidate.apiEndpoint) || null,
    })
    if (providerInfo?.requiresApiKey && !apiKey) continue
    return {
      provider,
      model,
      ollamaMode: candidate.ollamaMode || undefined,
      apiKey,
      apiEndpoint,
      thinkingLevel: candidate.thinkingLevel || undefined,
    }
  }
  return null
}

export function resolveGenerationModelConfig(options?: {
  preferred?: GenerationModelPreference | GenerationModelPreference[]
  sessionId?: string | null
  agentId?: string | null
  excludeProviders?: string[]
}): ResolvedGenerationModelConfig {
  const providers = getProviderList()
  const excludeProviders = new Set((options?.excludeProviders || []).map((value) => normalizePreferenceValue(value)).filter(Boolean))
  const session = options?.sessionId ? getSession(options.sessionId) : null
  const sessionAgent = session?.agentId ? getAgent(session.agentId) as Agent | null : null
  const directAgent = options?.agentId ? getAgent(options.agentId) as Agent | null : null
  const resolved = resolvePreferredGenerationConfig(providers, [
    ...(Array.isArray(options?.preferred) ? options?.preferred : options?.preferred ? [options.preferred] : []),
    ...(session ? [{
      provider: session.provider,
      model: session.model,
      ollamaMode: session.ollamaMode || null,
      credentialId: session.credentialId || null,
      apiEndpoint: session.apiEndpoint || null,
      gatewayProfileId: session.gatewayProfileId || null,
      thinkingLevel: session.thinkingLevel || null,
    }] : []),
    ...getAgentGenerationPreferences(sessionAgent),
    ...getAgentGenerationPreferences(directAgent),
  ], excludeProviders)
  if (resolved) return resolved

  const sessionLabel = options?.sessionId ? `session "${options.sessionId}"` : null
  const agentLabel = options?.agentId ? `agent "${options.agentId}"` : null
  const label = [sessionLabel, agentLabel].filter(Boolean).join(' / ') || 'this request'
  const providerHint = excludeProviders.size > 0
    ? ` Available providers excluded for this request: ${Array.from(excludeProviders).join(', ')}.`
    : ''
  throw new Error(`No generation-compatible model is configured for ${label}. Use a non-CLI provider or add a routed model target to the owning agent.${providerHint}`)
}

/**
 * Build a LangChain LLM for generation tasks from explicit session/agent-owned configuration.
 */
export async function buildLLM(options?: {
  preferred?: GenerationModelPreference | GenerationModelPreference[]
  sessionId?: string | null
  agentId?: string | null
  excludeProviders?: string[]
}) {
  const resolved = resolveGenerationModelConfig(options)
  return {
    llm: buildChatModel(resolved),
    provider: resolved.provider,
    model: resolved.model,
  }
}
