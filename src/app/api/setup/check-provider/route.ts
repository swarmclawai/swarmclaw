import { NextResponse } from 'next/server'
import { normalizeOpenClawEndpoint } from '@/lib/openclaw-endpoint'

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

const OPENAI_COMPATIBLE_PROVIDER_INFO: Record<
  'openai' | 'google' | 'deepseek' | 'groq' | 'together' | 'mistral' | 'xai' | 'fireworks',
  { name: string; defaultEndpoint: string }
> = {
  openai: { name: 'OpenAI', defaultEndpoint: 'https://api.openai.com/v1' },
  google: { name: 'Google Gemini', defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  deepseek: { name: 'DeepSeek', defaultEndpoint: 'https://api.deepseek.com/v1' },
  groq: { name: 'Groq', defaultEndpoint: 'https://api.groq.com/openai/v1' },
  together: { name: 'Together AI', defaultEndpoint: 'https://api.together.xyz/v1' },
  mistral: { name: 'Mistral AI', defaultEndpoint: 'https://api.mistral.ai/v1' },
  xai: { name: 'xAI (Grok)', defaultEndpoint: 'https://api.x.ai/v1' },
  fireworks: { name: 'Fireworks AI', defaultEndpoint: 'https://api.fireworks.ai/inference/v1' },
}

interface SetupCheckBody {
  provider?: string
  apiKey?: string
  endpoint?: string
  model?: string
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBody(input: unknown): SetupCheckBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return input as SetupCheckBody
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
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
): Promise<{ ok: boolean; message: string; normalizedEndpoint: string }> {
  const normalizedEndpoint = (endpointRaw || defaultEndpoint).replace(/\/+$/, '')
  const res = await fetch(`${normalizedEndpoint}/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `${providerName} returned ${res.status}.`)
    return { ok: false, message: detail, normalizedEndpoint }
  }
  const payload = await res.json().catch(() => ({} as any))
  const count = Array.isArray(payload?.data) ? payload.data.length : 0
  return {
    ok: true,
    message: count > 0 ? `Connected to ${providerName}. ${count} model(s) available.` : `Connected to ${providerName}.`,
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

async function checkOllama(endpointRaw: string): Promise<{ ok: boolean; message: string; normalizedEndpoint: string; recommendedModel?: string }> {
  const normalizedEndpoint = (endpointRaw || 'http://localhost:11434').replace(/\/+$/, '')
  const res = await fetch(`${normalizedEndpoint}/api/tags`, {
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `Ollama returned ${res.status}.`)
    return { ok: false, message: detail, normalizedEndpoint }
  }
  const payload = await res.json().catch(() => ({} as any))
  const models = Array.isArray(payload?.models) ? payload.models : []
  const firstModel = typeof models[0]?.name === 'string'
    ? String(models[0].name).replace(/:latest$/, '')
    : undefined
  if (models.length === 0) {
    return {
      ok: true,
      message: 'Connected to Ollama, but no models are installed yet. Run `ollama pull <model>` to add one.',
      normalizedEndpoint,
    }
  }
  return {
    ok: true,
    message: `Connected to Ollama. ${models.length} model(s) available.`,
    normalizedEndpoint,
    recommendedModel: firstModel,
  }
}

async function checkOpenClaw(apiKey: string, endpointRaw: string, modelRaw: string): Promise<{ ok: boolean; message: string; normalizedEndpoint: string; recommendedModel?: string }> {
  const normalizedEndpoint = normalizeOpenClawEndpoint(endpointRaw || 'http://localhost:18789/v1')
  const headers: Record<string, string> = {}
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const modelsRes = await fetch(`${normalizedEndpoint}/models`, {
    headers,
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  })
  if (!modelsRes.ok) {
    const detail = await parseErrorMessage(modelsRes, `OpenClaw returned ${modelsRes.status}.`)
    return { ok: false, message: detail, normalizedEndpoint }
  }

  const modelsPayload = await modelsRes.json().catch(() => ({} as any))
  const candidates = Array.isArray(modelsPayload?.data)
    ? modelsPayload.data
    : Array.isArray(modelsPayload?.models)
      ? modelsPayload.models
      : []
  const firstModel = candidates
    .map((entry: any) => String(entry?.id || entry?.name || entry?.model || '').trim())
    .find((value: string) => !!value)
  const model = modelRaw || firstModel || 'default'
  const chatRes = await fetch(`${normalizedEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with OPENCLAW_SETUP_OK' }],
      stream: false,
      max_tokens: 12,
    }),
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  })
  if (!chatRes.ok) {
    const detail = await parseErrorMessage(chatRes, `OpenClaw returned ${chatRes.status}.`)
    return { ok: false, message: detail, normalizedEndpoint, recommendedModel: firstModel }
  }

  const payload = await chatRes.json().catch(() => ({} as any))
  const text = typeof payload?.choices?.[0]?.message?.content === 'string'
    ? payload.choices[0].message.content.trim()
    : ''

  return {
    ok: true,
    message: text ? `Connected to OpenClaw. Sample: ${text.slice(0, 120)}` : 'Connected to OpenClaw.',
    normalizedEndpoint,
    recommendedModel: firstModel,
  }
}

export async function POST(req: Request) {
  const body = parseBody(await req.json().catch(() => ({})))
  const provider = clean(body.provider) as SetupProvider
  const apiKey = clean(body.apiKey)
  const endpoint = clean(body.endpoint)
  const model = clean(body.model)

  if (!provider) {
    return NextResponse.json({ ok: false, message: 'Provider is required.' }, { status: 400 })
  }

  try {
    switch (provider) {
      case 'openai': {
        if (!apiKey) return NextResponse.json({ ok: false, message: 'OpenAI API key is required.' })
        const info = OPENAI_COMPATIBLE_PROVIDER_INFO.openai
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint)
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
        const info = OPENAI_COMPATIBLE_PROVIDER_INFO[provider]
        if (!apiKey) return NextResponse.json({ ok: false, message: `${info.name} API key is required.` })
        const result = await checkOpenAiCompatible(info.name, apiKey, endpoint, info.defaultEndpoint)
        return NextResponse.json(result)
      }
      case 'ollama': {
        const result = await checkOllama(endpoint)
        return NextResponse.json(result)
      }
      case 'openclaw': {
        const result = await checkOpenClaw(apiKey, endpoint, model)
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
