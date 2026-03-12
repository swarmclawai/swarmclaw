import { NextResponse } from 'next/server'
import { loadCredentials, decryptKey } from '@/lib/server/storage'
import { getDeviceId, wsConnect } from '@/lib/providers/openclaw'
import { OPENAI_COMPATIBLE_DEFAULTS } from '@/lib/server/provider-health'
import { resolveOllamaRuntimeConfig } from '@/lib/server/ollama-runtime'

type SetupProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'together'
  | 'mistral'
  | 'xai'
  | 'fireworks'
  | 'ollama'
  | 'openclaw'

interface SetupCheckBody {
  provider?: string
  apiKey?: string
  credentialId?: string
  endpoint?: string
  model?: string
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeOllamaSetupEndpoint(endpoint: string, useCloud: boolean): string {
  const normalized = endpoint.replace(/\/+$/, '')
  if (useCloud) return normalized
  return normalized.replace(/\/v1$/i, '')
}

function parseBody(input: unknown): SetupCheckBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return input as SetupCheckBody
}

export async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) return parsed.error.message.trim()
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch {
    // Non-JSON response body.
  }
  return text.slice(0, 300).trim() || fallback
}

async function checkOpenAiCompatible(
  providerName: string,
  apiKey: string,
  endpointRaw: string,
  defaultEndpoint: string,
  modelHint?: string,
): Promise<{ ok: boolean; message: string; normalizedEndpoint: string }> {
  const normalizedEndpoint = (endpointRaw || defaultEndpoint).replace(/\/+$/, '')

  // First, discover a model to test with (prefer the hint, fall back to the first available model)
  let testModel = modelHint || ''
  if (!testModel) {
    try {
      const modelsRes = await fetch(`${normalizedEndpoint}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      })
      if (modelsRes.ok) {
        const modelsPayload = await modelsRes.json().catch(() => ({} as any))
        const first = Array.isArray(modelsPayload?.data) ? modelsPayload.data[0] : null
        if (first?.id) testModel = String(first.id)
      }
    } catch {
      // Model discovery failed — we'll still try the chat endpoint with the provider's default
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
    }
    testModel = fallbacks[providerName] || 'gpt-4o-mini'
  }

  // Test the chat completions endpoint with a minimal request
  const res = await fetch(`${normalizedEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: testModel,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply OK' }],
    }),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `${providerName} returned ${res.status}.`)
    return { ok: false, message: detail, normalizedEndpoint }
  }
  return {
    ok: true,
    message: `Connected to ${providerName}. Chat endpoint verified with ${testModel}.`,
    normalizedEndpoint,
  }
}

async function checkAnthropic(apiKey: string, modelRaw: string): Promise<{ ok: boolean; message: string }> {
  const model = modelRaw || 'claude-sonnet-4-6'
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `Anthropic returned ${res.status}.`)
    return { ok: false, message: detail }
  }
  const payload = await res.json().catch(() => ({} as any))
  const text = typeof payload?.content?.[0]?.text === 'string' ? payload.content[0].text : ''
  return { ok: true, message: text ? `Connected to Anthropic. Sample: ${text.slice(0, 120)}` : 'Connected to Anthropic.' }
}

async function checkOllama(params: {
  endpointRaw: string
  modelRaw: string
  apiKey?: string
}): Promise<{ ok: boolean; message: string; normalizedEndpoint: string; recommendedModel?: string }> {
  const runtime = resolveOllamaRuntimeConfig({
    model: params.modelRaw,
    apiKey: params.apiKey,
    apiEndpoint: params.endpointRaw,
  })
  const normalizedEndpoint = normalizeOllamaSetupEndpoint(runtime.endpoint, runtime.useCloud)
  const headers: Record<string, string> = runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {}
  if (runtime.useCloud && !runtime.apiKey) {
    return {
      ok: false,
      message: 'Ollama Cloud model requires an API key. Set OLLAMA_API_KEY or attach an Ollama credential.',
      normalizedEndpoint,
    }
  }

  // Discover a model to test with
  let testModel = params.modelRaw || ''
  let recommendedModel: string | undefined
  if (!testModel) {
    try {
      const tagsPath = runtime.useCloud ? '/v1/models' : '/api/tags'
      const res = await fetch(`${normalizedEndpoint}${tagsPath}`, {
        headers: headers.authorization ? headers : undefined,
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      })
      if (res.ok) {
        const payload = await res.json().catch(() => ({} as any))
        const models = runtime.useCloud
          ? (Array.isArray(payload?.data) ? payload.data : [])
          : (Array.isArray(payload?.models) ? payload.models : [])
        const firstModel = runtime.useCloud
          ? (typeof models[0]?.id === 'string' ? String(models[0].id) : undefined)
          : (typeof models[0]?.name === 'string' ? String(models[0].name).replace(/:latest$/, '') : undefined)
        if (firstModel) {
          testModel = firstModel
          recommendedModel = firstModel
        }
        if (models.length === 0) {
          return {
            ok: true,
            message: runtime.useCloud
              ? 'Connected to Ollama Cloud, but no models were returned.'
              : 'Connected to Ollama, but no models are installed yet. Run `ollama pull <model>` to add one.',
            normalizedEndpoint,
          }
        }
      }
    } catch {
      // Model discovery failed — try chat anyway
    }
  }

  if (!testModel) testModel = 'llama3.2'

  // Test the chat endpoint
  const label = runtime.useCloud ? 'Ollama Cloud' : 'Ollama'
  const chatEndpoint = `${normalizedEndpoint}/v1/chat/completions`
  const chatBody = JSON.stringify({ model: testModel, max_tokens: 8, messages: [{ role: 'user', content: 'Reply OK' }] })

  const chatRes = await fetch(chatEndpoint, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: chatBody,
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  })
  if (!chatRes.ok) {
    const detail = await parseErrorMessage(chatRes, `${label} chat returned ${chatRes.status}.`)
    return { ok: false, message: detail, normalizedEndpoint, recommendedModel }
  }
  return {
    ok: true,
    message: `Connected to ${label}. Chat verified with ${testModel}.`,
    normalizedEndpoint,
    recommendedModel: recommendedModel || testModel,
  }
}

export function normalizeOpenClawUrl(raw: string): { httpUrl: string; wsUrl: string } {
  let url = (raw || 'http://localhost:18789').replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(url)) url = `http://${url}`
  const httpUrl = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  const wsUrl = httpUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  return { httpUrl, wsUrl }
}

async function checkOpenClaw(apiKey: string, endpointRaw: string): Promise<{ ok: boolean; message: string; normalizedEndpoint: string; deviceId?: string; errorCode?: string }> {
  const { httpUrl: normalizedEndpoint, wsUrl } = normalizeOpenClawUrl(endpointRaw)
  const token = apiKey || undefined
  const deviceId = getDeviceId()

  const result = await wsConnect(wsUrl, token, true, 10_000)
  // Close the WebSocket immediately — we only care about the handshake result
  if (result.ws) try { result.ws.close() } catch {}

  if (result.ok) {
    return { ok: true, message: 'Connected to OpenClaw gateway.', normalizedEndpoint, deviceId }
  }
  return { ok: false, message: result.message, normalizedEndpoint, deviceId, errorCode: result.errorCode }
}

export async function POST(req: Request) {
  const body = parseBody(await req.json().catch(() => ({})))
  const provider = clean(body.provider) as SetupProvider
  let apiKey = clean(body.apiKey)
  const credentialId = clean(body.credentialId)
  const endpoint = clean(body.endpoint)
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

  if (!provider) {
    return NextResponse.json({ ok: false, message: 'Provider is required.' }, { status: 400 })
  }

  try {
    switch (provider) {
      case 'openai': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'OpenAI API key is required.' })
        const info = OPENAI_COMPATIBLE_DEFAULTS.openai
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint, model)
        return NextResponse.json(result)
      }
      case 'anthropic': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'Anthropic API key is required.' })
        const result = await checkAnthropic(apiKey, model)
        return NextResponse.json(result)
      }
      case 'google':
      case 'deepseek':
      case 'groq':
      case 'together':
      case 'mistral':
      case 'xai':
      case 'fireworks': {
        const info = OPENAI_COMPATIBLE_DEFAULTS[provider]
        if (!apiKey) return NextResponse.json({ ok: false, message: `${info.name} API key is required.` })
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint, model)
        return NextResponse.json(result)
      }
      case 'ollama': {
        const result = await checkOllama({ endpointRaw: endpoint, modelRaw: model, apiKey })
        return NextResponse.json(result)
      }
      case 'openclaw': {
        const result = await checkOpenClaw(apiKey, endpoint)
        return NextResponse.json(result)
      }
      default:
        return NextResponse.json({ ok: false, message: `Unsupported provider: ${provider}` }, { status: 400 })
    }
  } catch (err: any) {
    const message = err?.name === 'TimeoutError'
      ? 'Connection check timed out. Verify endpoint/network and try again.'
      : (err?.message || 'Failed to validate provider setup.')
    return NextResponse.json({ ok: false, message }, { status: 500 })
  }
}
