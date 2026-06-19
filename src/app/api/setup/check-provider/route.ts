import { NextResponse } from 'next/server'
import { loadCredentials, decryptKey, loadProviderConfigs } from '@/lib/server/storage'
import { listCredentialIdsByProvider } from '@/lib/server/credentials/credential-service'
import { getDeviceId, wsConnect, rpcOnConnectedGateway } from '@/lib/providers/openclaw'
import { isCliProviderId } from '@/lib/providers/cli-provider-metadata'
import { checkCliProviderReady } from '@/lib/server/cli-provider-readiness'
import { createProviderDiagnostics, sanitizeProviderDiagnosticText } from '@/lib/server/provider-diagnostics'
import { OPENAI_COMPATIBLE_DEFAULTS } from '@/lib/server/provider-health'
import { normalizeLmStudioEndpoint, normalizeOpenAiCompatibleV1Endpoint } from '@/lib/providers/openai-compatible-endpoint'
import { resolveOllamaRuntimeConfig } from '@/lib/server/ollama-runtime'
import { normalizeOllamaSetupEndpoint, normalizeOpenClawUrl, parseErrorMessage } from './helpers'
import type { ProviderCheckResult } from '@/types/provider'

interface SetupCheckBody {
  provider?: string
  apiKey?: string
  credentialId?: string
  endpoint?: string
  model?: string
  ollamaMode?: string
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBody(input: unknown): SetupCheckBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return input as SetupCheckBody
}

async function checkOpenAiCompatible(
  providerName: string,
  apiKey: string,
  endpointRaw: string,
  defaultEndpoint: string,
  modelHint?: string,
): Promise<ProviderCheckResult> {
  const diagnostics = createProviderDiagnostics()
  const normalizedEndpoint = (endpointRaw || defaultEndpoint).replace(/\/+$/, '')
  diagnostics.pass('Endpoint resolved', { target: normalizedEndpoint })
  const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined

  // First, discover a model to test with (prefer the hint, fall back to the first available model)
  let testModel = modelHint || ''
  if (testModel) {
    diagnostics.pass('Test model selected', { detail: testModel })
  } else {
    const modelsTarget = `${normalizedEndpoint}/models`
    const startedAt = Date.now()
    try {
      const modelsRes = await fetch(modelsTarget, {
        headers: authHeaders,
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      })
      if (modelsRes.ok) {
        const modelsPayload = await modelsRes.json().catch(() => ({} as Record<string, unknown>))
        const first = Array.isArray(modelsPayload?.data) ? modelsPayload.data[0] : null
        if (first?.id) {
          testModel = String(first.id)
          diagnostics.pass('Model discovery completed', {
            target: modelsTarget,
            detail: `Using ${testModel}`,
            durationMs: Date.now() - startedAt,
          })
        } else {
          diagnostics.warn('Model discovery returned no models', {
            target: modelsTarget,
            durationMs: Date.now() - startedAt,
          })
        }
      } else {
        const detail = sanitizeProviderDiagnosticText(await parseErrorMessage(modelsRes, `${providerName} models returned ${modelsRes.status}.`))
        diagnostics.warn('Model discovery failed', {
          target: modelsTarget,
          detail: `HTTP ${modelsRes.status}: ${detail}`,
          durationMs: Date.now() - startedAt,
        })
      }
    } catch (err: unknown) {
      diagnostics.warn('Model discovery request failed', {
        target: modelsTarget,
        detail: err instanceof Error && err.message ? err.message : 'Unable to query models.',
        durationMs: Date.now() - startedAt,
      })
    }
  }

  // Fall back to a reasonable default per provider
  if (!testModel) {
    const fallbacks: Record<string, string> = {
      OpenAI: 'gpt-4o-mini',
      'Google Gemini': 'gemini-2.0-flash',
      DeepSeek: 'deepseek-chat',
      Groq: 'llama-3.3-70b-versatile',
      'Together AI': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Mistral AI': 'mistral-small-latest',
      'xAI (Grok)': 'grok-3-mini-fast',
      'Fireworks AI': 'accounts/fireworks/models/llama4-scout-instruct-basic',
      Nebius: 'deepseek-ai/DeepSeek-R1-0528',
      DeepInfra: 'deepseek-ai/DeepSeek-R1-0528',
      OpenRouter: 'openai/gpt-4.1-mini',
      'Hermes Agent': 'hermes-agent',
      'LM Studio': 'local-model',
    }
    testModel = fallbacks[providerName] || 'gpt-4o-mini'
    diagnostics.warn('Fallback test model selected', { detail: testModel })
  }

  // Test the chat completions endpoint with a minimal request
  const chatTarget = `${normalizedEndpoint}/chat/completions`
  const chatStartedAt = Date.now()
  let res: Response
  try {
    res = await fetch(chatTarget, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authHeaders || {}),
      },
      body: JSON.stringify({
        model: testModel,
        max_completion_tokens: 8,
        messages: [{ role: 'user', content: 'Reply OK' }],
      }),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    })
  } catch (err: unknown) {
    const message = err instanceof Error && err.name === 'TimeoutError'
      ? 'Connection check timed out. Verify endpoint/network and try again.'
      : (err instanceof Error && err.message ? err.message : 'Chat endpoint request failed.')
    diagnostics.fail('Chat completion request failed', {
      target: chatTarget,
      detail: message,
      durationMs: Date.now() - chatStartedAt,
    })
    return { ok: false, message: sanitizeProviderDiagnosticText(message), normalizedEndpoint, diagnostics: diagnostics.toJSON() }
  }
  if (!res.ok) {
    const detail = sanitizeProviderDiagnosticText(await parseErrorMessage(res, `${providerName} returned ${res.status}.`))
    diagnostics.fail('Chat completion check failed', {
      target: chatTarget,
      detail: `HTTP ${res.status}: ${detail}`,
      durationMs: Date.now() - chatStartedAt,
    })
    return { ok: false, message: detail, normalizedEndpoint, diagnostics: diagnostics.toJSON() }
  }
  diagnostics.pass('Chat completion check passed', {
    target: chatTarget,
    detail: `Verified with ${testModel}`,
    durationMs: Date.now() - chatStartedAt,
  })
  return {
    ok: true,
    message: `Connected to ${providerName}. Chat endpoint verified with ${testModel}.`,
    normalizedEndpoint,
    diagnostics: diagnostics.toJSON(),
  }
}

async function checkAnthropic(apiKey: string, endpointRaw: string, modelRaw: string): Promise<ProviderCheckResult> {
  const diagnostics = createProviderDiagnostics()
  const model = modelRaw || 'claude-sonnet-4-6'
  const baseUrl = (endpointRaw || 'https://api.anthropic.com').replace(/\/+$/, '')
  diagnostics.pass('Endpoint resolved', { target: baseUrl })
  diagnostics.pass('Test model selected', { detail: model })
  const target = `${baseUrl}/v1/messages`
  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 12,
        messages: [{ role: 'user', content: 'Reply with ANTHROPIC_SETUP_OK' }],
      }),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    })
  } catch (err: unknown) {
    const message = err instanceof Error && err.name === 'TimeoutError'
      ? 'Connection check timed out. Verify endpoint/network and try again.'
      : (err instanceof Error && err.message ? err.message : 'Anthropic request failed.')
    diagnostics.fail('Message check request failed', {
      target,
      detail: message,
      durationMs: Date.now() - startedAt,
    })
    return { ok: false, message: sanitizeProviderDiagnosticText(message), diagnostics: diagnostics.toJSON() }
  }
  if (!res.ok) {
    const detail = sanitizeProviderDiagnosticText(await parseErrorMessage(res, `Anthropic returned ${res.status}.`))
    diagnostics.fail('Message check failed', {
      target,
      detail: `HTTP ${res.status}: ${detail}`,
      durationMs: Date.now() - startedAt,
    })
    return { ok: false, message: detail, diagnostics: diagnostics.toJSON() }
  }
  const payload = await res.json().catch(() => ({} as Record<string, unknown>))
  const content = Array.isArray(payload.content) ? payload.content : []
  const firstContent = content[0]
  const text = firstContent && typeof firstContent === 'object' && 'text' in firstContent && typeof firstContent.text === 'string'
    ? firstContent.text
    : ''
  diagnostics.pass('Message check passed', {
    target,
    detail: text ? `Sample: ${text.slice(0, 80)}` : 'Provider returned a successful response.',
    durationMs: Date.now() - startedAt,
  })
  return { ok: true, message: text ? `Connected to Anthropic. Sample: ${text.slice(0, 120)}` : 'Connected to Anthropic.', diagnostics: diagnostics.toJSON() }
}

async function checkOllama(params: {
  endpointRaw: string
  modelRaw: string
  ollamaMode?: string
  apiKey?: string
}): Promise<ProviderCheckResult> {
  const diagnostics = createProviderDiagnostics()
  const runtime = resolveOllamaRuntimeConfig({
    model: params.modelRaw,
    ollamaMode: params.ollamaMode ?? null,
    apiKey: params.apiKey,
    apiEndpoint: params.endpointRaw,
  })
  const normalizedEndpoint = normalizeOllamaSetupEndpoint(runtime.endpoint, runtime.useCloud)
  diagnostics.pass('Endpoint resolved', {
    target: normalizedEndpoint,
    detail: runtime.useCloud ? 'Ollama Cloud mode' : 'Local Ollama mode',
  })
  const headers: Record<string, string> = runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}
  if (runtime.useCloud && !runtime.apiKey) {
    diagnostics.fail('Credential required', { detail: 'Ollama Cloud requires an API key.' })
    return {
      ok: false,
      message: 'Ollama Cloud model requires an API key. Set OLLAMA_API_KEY or attach an Ollama credential.',
      normalizedEndpoint,
      diagnostics: diagnostics.toJSON(),
    }
  }

  // Discover a model to test with
  let testModel = params.modelRaw || ''
  let recommendedModel: string | undefined
  if (testModel) {
    diagnostics.pass('Test model selected', { detail: testModel })
  } else {
    const tagsPath = runtime.useCloud ? '/v1/models' : '/api/tags'
    const target = `${normalizedEndpoint}${tagsPath}`
    const startedAt = Date.now()
    try {
      const res = await fetch(target, {
        headers: headers.authorization ? headers : undefined,
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      })
      if (res.ok) {
        const payload = await res.json().catch(() => ({} as Record<string, unknown>))
        const models = runtime.useCloud
          ? (Array.isArray(payload?.data) ? payload.data : [])
          : (Array.isArray(payload?.models) ? payload.models : [])
        const firstModel = runtime.useCloud
          ? (typeof models[0]?.id === 'string' ? String(models[0].id) : undefined)
          : (typeof models[0]?.name === 'string' ? String(models[0].name).replace(/:latest$/, '') : undefined)
        if (firstModel) {
          testModel = firstModel
          recommendedModel = firstModel
          diagnostics.pass('Model discovery completed', {
            target,
            detail: `Using ${firstModel}`,
            durationMs: Date.now() - startedAt,
          })
        }
        if (models.length === 0) {
          diagnostics.warn('Model discovery returned no models', {
            target,
            durationMs: Date.now() - startedAt,
          })
          return {
            ok: true,
            message: runtime.useCloud
              ? 'Connected to Ollama Cloud, but no models were returned.'
              : 'Connected to Ollama, but no models are installed yet. Run `ollama pull <model>` to add one.',
            normalizedEndpoint,
            diagnostics: diagnostics.toJSON(),
          }
        }
      } else {
        const detail = sanitizeProviderDiagnosticText(await parseErrorMessage(res, `Ollama model discovery returned ${res.status}.`))
        diagnostics.warn('Model discovery failed', {
          target,
          detail: `HTTP ${res.status}: ${detail}`,
          durationMs: Date.now() - startedAt,
        })
      }
    } catch (err: unknown) {
      diagnostics.warn('Model discovery request failed', {
        target,
        detail: err instanceof Error && err.message ? err.message : 'Unable to query models.',
        durationMs: Date.now() - startedAt,
      })
    }
  }

  if (!testModel) {
    testModel = 'llama3.2'
    diagnostics.warn('Fallback test model selected', { detail: testModel })
  }

  // Test the chat endpoint
  const label = runtime.useCloud ? 'Ollama Cloud' : 'Ollama'
  const chatEndpoint = `${normalizedEndpoint}/v1/chat/completions`
  const chatBody = JSON.stringify({ model: testModel, max_completion_tokens: 8, messages: [{ role: 'user', content: 'Reply OK' }] })

  const chatStartedAt = Date.now()
  let chatRes: Response
  try {
    chatRes = await fetch(chatEndpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: chatBody,
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    })
  } catch (err: unknown) {
    const message = err instanceof Error && err.name === 'TimeoutError'
      ? 'Connection check timed out. Verify endpoint/network and try again.'
      : (err instanceof Error && err.message ? err.message : 'Ollama chat request failed.')
    diagnostics.fail('Chat completion request failed', {
      target: chatEndpoint,
      detail: message,
      durationMs: Date.now() - chatStartedAt,
    })
    return { ok: false, message: sanitizeProviderDiagnosticText(message), normalizedEndpoint, recommendedModel, diagnostics: diagnostics.toJSON() }
  }
  if (!chatRes.ok) {
    const detail = sanitizeProviderDiagnosticText(await parseErrorMessage(chatRes, `${label} chat returned ${chatRes.status}.`))
    diagnostics.fail('Chat completion check failed', {
      target: chatEndpoint,
      detail: `HTTP ${chatRes.status}: ${detail}`,
      durationMs: Date.now() - chatStartedAt,
    })
    return { ok: false, message: detail, normalizedEndpoint, recommendedModel, diagnostics: diagnostics.toJSON() }
  }
  diagnostics.pass('Chat completion check passed', {
    target: chatEndpoint,
    detail: `Verified with ${testModel}`,
    durationMs: Date.now() - chatStartedAt,
  })
  return {
    ok: true,
    message: `Connected to ${label}. Chat verified with ${testModel}.`,
    normalizedEndpoint,
    recommendedModel: recommendedModel || testModel,
    diagnostics: diagnostics.toJSON(),
  }
}

async function checkOpenClaw(apiKey: string, endpointRaw: string): Promise<ProviderCheckResult> {
  const diagnostics = createProviderDiagnostics()
  const { httpUrl: normalizedEndpoint, wsUrl } = normalizeOpenClawUrl(endpointRaw)
  const token = apiKey || undefined
  const deviceId = getDeviceId()
  diagnostics.pass('Endpoint resolved', { target: normalizedEndpoint })

  const wsStartedAt = Date.now()
  const result = await wsConnect(wsUrl, token, true, 10_000)

  if (!result.ok) {
    if (result.ws) try { result.ws.close() } catch {}
    diagnostics.fail('Gateway websocket check failed', {
      target: wsUrl,
      detail: result.message,
      durationMs: Date.now() - wsStartedAt,
    })
    return { ok: false, message: sanitizeProviderDiagnosticText(result.message), normalizedEndpoint, deviceId, errorCode: result.errorCode, diagnostics: diagnostics.toJSON() }
  }
  diagnostics.pass('Gateway websocket check passed', {
    target: wsUrl,
    detail: deviceId ? `Device ${deviceId}` : undefined,
    durationMs: Date.now() - wsStartedAt,
  })

  // Attempt model discovery via RPC before closing the connection
  let recommendedModel: string | undefined
  if (result.ws) {
    const modelStartedAt = Date.now()
    try {
      const payload = await rpcOnConnectedGateway(result.ws, 'models.list', {}, 8_000) as Record<string, unknown> | unknown[] | undefined
      const p = payload as Record<string, unknown> | undefined
      const models: unknown[] = Array.isArray(p?.models) ? p.models as unknown[] : Array.isArray(p?.data) ? p.data as unknown[] : Array.isArray(payload) ? payload : []
      const first = models[0] as Record<string, unknown> | string | undefined
      if (typeof first === 'string') {
        recommendedModel = first
      } else if (typeof first?.id === 'string') {
        recommendedModel = first.id
      } else if (typeof first?.name === 'string') {
        recommendedModel = first.name
      }
      diagnostics.pass('Gateway model discovery completed', {
        detail: recommendedModel ? `Using ${recommendedModel}` : 'No model recommendation returned.',
        durationMs: Date.now() - modelStartedAt,
      })
    } catch (err: unknown) {
      diagnostics.warn('Gateway model discovery failed', {
        detail: err instanceof Error && err.message ? err.message : 'Model discovery is unavailable.',
        durationMs: Date.now() - modelStartedAt,
      })
    }
    try { result.ws.close() } catch {}
  }

  return { ok: true, message: 'Connected to OpenClaw gateway.', normalizedEndpoint, deviceId, recommendedModel, diagnostics: diagnostics.toJSON() }
}

export async function POST(req: Request) {
  const body = parseBody(await req.json().catch(() => ({})))
  const provider = clean(body.provider)
  let apiKey = clean(body.apiKey)
  const credentialId = clean(body.credentialId)
  let endpoint = clean(body.endpoint)
  const model = clean(body.model)

  // Resolve credentialId to an API key if no raw key was provided
  if (!apiKey && credentialId) {
    try {
      const creds = loadCredentials()
      const cred = creds[credentialId]
      if (cred?.encryptedKey) {
        apiKey = decryptKey(cred.encryptedKey)
      }
    } catch {
      return NextResponse.json({ ok: false, message: 'Failed to decrypt credential.' }, { status: 500 })
    }
  }

  // Auto-resolve credential by provider when no explicit credentialId
  if (!apiKey && !credentialId && provider) {
    try {
      const credIds = listCredentialIdsByProvider(provider)
      if (credIds.length > 0) {
        const creds = loadCredentials()
        for (const cid of credIds) {
          if (creds[cid]?.encryptedKey) {
            try { apiKey = decryptKey(creds[cid].encryptedKey); break } catch { /* skip */ }
          }
        }
      }
    } catch { /* best effort */ }
  }

  // Auto-resolve endpoint from provider config when not explicitly provided
  if (!endpoint && provider) {
    try {
      const pConfigs = loadProviderConfigs()
      const pConfig = pConfigs[provider]
      if (pConfig?.baseUrl) endpoint = pConfig.baseUrl
    } catch { /* best effort */ }
  }

  if (isCliProviderId(provider)) {
    const result = checkCliProviderReady(provider)
    const diagnostics = createProviderDiagnostics()
    diagnostics.add('CLI readiness check', result.ok ? 'pass' : 'fail', {
      detail: result.message,
      target: result.binaryPath || result.binaryName || provider,
    })
    return NextResponse.json({ ...result, diagnostics: diagnostics.toJSON() })
  }

  if (!provider) {
    return NextResponse.json({ ok: false, message: 'Provider is required.' }, { status: 400 })
  }

  try {
    switch (provider) {
      case 'openai': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'OpenAI API key is required.' })
        const info = OPENAI_COMPATIBLE_DEFAULTS.openai
        const result = await checkOpenAiCompatible(
          info.name,
          apiKey,
          normalizeOpenAiCompatibleV1Endpoint(endpoint || info.defaultEndpoint, info.defaultEndpoint),
          info.defaultEndpoint,
          model,
        )
        return NextResponse.json(result)
      }
      case 'openrouter': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'OpenRouter API key is required.' })
        const info = OPENAI_COMPATIBLE_DEFAULTS.openrouter
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint, model)
        return NextResponse.json(result)
      }
      case 'tokenmix': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'TokenMix API key is required.' })
        const info = OPENAI_COMPATIBLE_DEFAULTS.tokenmix
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint, model)
        return NextResponse.json(result)
      }
      case 'anthropic': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'Anthropic API key is required.' })
        const result = await checkAnthropic(apiKey, endpoint, model)
        return NextResponse.json(result)
      }
      case 'google':
      case 'deepseek':
      case 'groq':
      case 'together':
      case 'mistral':
      case 'xai':
      case 'fireworks':
      case 'nebius':
      case 'requesty':
      case 'deepinfra': {
        const info = OPENAI_COMPATIBLE_DEFAULTS[provider]
        if (!apiKey) return NextResponse.json({ ok: false, message: `${info.name} API key is required.` })
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint, model)
        return NextResponse.json(result)
      }
      case 'hermes': {
        const info = OPENAI_COMPATIBLE_DEFAULTS.hermes
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint, model)
        return NextResponse.json(result)
      }
      case 'lmstudio': {
        const info = OPENAI_COMPATIBLE_DEFAULTS.lmstudio
        const result = await checkOpenAiCompatible(
          info.name,
          apiKey,
          normalizeLmStudioEndpoint(endpoint || info.defaultEndpoint),
          info.defaultEndpoint,
          model,
        )
        return NextResponse.json(result)
      }
      case 'ollama': {
        const result = await checkOllama({
          endpointRaw: endpoint,
          modelRaw: model,
          ollamaMode: body.ollamaMode,
          apiKey,
        })
        return NextResponse.json(result)
      }
      case 'openclaw': {
        const result = await checkOpenClaw(apiKey, endpoint)
        return NextResponse.json(result)
      }
      default: {
        let configs: Record<string, { name?: string; baseUrl?: string; isEnabled?: boolean }>
        try {
          const storage = await import('@/lib/server/storage')
          configs = storage.loadProviderConfigs() as Record<string, { name?: string; baseUrl?: string; isEnabled?: boolean }>
        } catch {
          return NextResponse.json(
            { ok: false, message: `Failed to load provider configurations while checking ${provider}.` },
            { status: 500 },
          )
        }
        const custom = configs[provider]
        if (custom?.baseUrl) {
          const result = await checkOpenAiCompatible(
            custom.name || 'Custom Provider',
            apiKey || '',
            endpoint || custom.baseUrl,
            custom.baseUrl,
            model
          )
          return NextResponse.json(result)
        }
        return NextResponse.json({ ok: false, message: `Unsupported provider: ${provider}` }, { status: 400 })
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error && err.name === 'TimeoutError'
      ? 'Connection check timed out. Verify endpoint/network and try again.'
      : (err instanceof Error && err.message ? err.message : 'Failed to validate provider setup.')
    return NextResponse.json({ ok: false, message }, { status: 500 })
  }
}
