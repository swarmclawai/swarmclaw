import { deriveOpenClawWsUrl, normalizeOpenClawEndpoint } from '@/lib/openclaw-endpoint'
import { decryptKey, loadCredentials } from './storage'

export interface OpenClawHealthInput {
  endpoint?: string | null
  credentialId?: string | null
  token?: string | null
  model?: string | null
  timeoutMs?: number
}

export interface OpenClawHealthResult {
  ok: boolean
  endpoint: string
  wsUrl: string
  authProvided: boolean
  model: string | null
  models: string[]
  modelsStatus: number | null
  chatStatus: number | null
  completionSample?: string
  error?: string
  hint?: string
}

function normalizeToken(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveCredentialToken(credentialId?: string | null): string | null {
  const id = normalizeToken(credentialId)
  if (!id) return null
  const credentials = loadCredentials()
  const credential = credentials[id]
  if (!credential?.encryptedKey) return null
  try {
    return decryptKey(credential.encryptedKey)
  } catch {
    return null
  }
}

function extractModels(payload: any): string[] {
  const models = Array.isArray(payload?.data) ? payload.data : []
  return models
    .map((item: any) => (typeof item?.id === 'string' ? item.id.trim() : ''))
    .filter(Boolean)
}

function extractChatText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block?.text === 'string') return block.text
        if (typeof block?.content === 'string') return block.content
        return ''
      })
      .join(' ')
      .trim()
  }
  return ''
}

function describeHttpError(status: number): { error: string; hint?: string } {
  if (status === 401) {
    return {
      error: 'OpenClaw endpoint rejected auth (401 Unauthorized).',
      hint: 'Set a valid OpenClaw token credential on the agent/session or pass credentialId/token to this health check.',
    }
  }
  if (status === 404) {
    return {
      error: 'OpenClaw endpoint path is invalid (404).',
      hint: 'Point to the gateway root/ws URL and let SwarmClaw normalize it, or use an explicit /v1 endpoint.',
    }
  }
  if (status === 405) {
    return {
      error: 'OpenClaw endpoint method mismatch (405).',
      hint: 'Ensure this is an OpenAI-compatible chat endpoint exposed by the OpenClaw gateway.',
    }
  }
  return {
    error: `OpenClaw endpoint returned HTTP ${status}.`,
  }
}

function createTimeoutError(message: string): Error {
  const timeoutErr = new Error(message)
  ;(timeoutErr as any).name = 'TimeoutError'
  return timeoutErr
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.() } catch { /* noop */ }
        reject(createTimeoutError(message || `Request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      promise
        .then((value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        })
        .catch((err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        })
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; body: any }> {
  const controller = new AbortController()
  try {
    const response = await withTimeout(
      fetch(url, { ...init, signal: controller.signal }),
      timeoutMs,
      () => controller.abort(),
      `Request timed out after ${timeoutMs}ms`,
    )
    const text = await withTimeout(
      response.text(),
      timeoutMs,
      () => controller.abort(),
      `Response read timed out after ${timeoutMs}ms`,
    )
    let body: any = {}
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = {}
      }
    }
    return { response, body }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw createTimeoutError(`Request timed out after ${timeoutMs}ms`)
    throw err
  }
}

export async function probeOpenClawHealth(input: OpenClawHealthInput): Promise<OpenClawHealthResult> {
  const endpoint = normalizeOpenClawEndpoint(input.endpoint || undefined)
  const wsUrl = deriveOpenClawWsUrl(endpoint)
  const timeoutMs = Math.max(1000, Math.min(30_000, Math.trunc(input.timeoutMs || 8000)))
  const token = normalizeToken(input.token) || resolveCredentialToken(input.credentialId)
  const authProvided = !!token
  const headers: Record<string, string> = {
    // Use text/plain to bypass Express body parsers in Hostinger/proxy setups.
    // The OpenClaw gateway parses the body as JSON regardless of Content-Type.
    'content-type': 'text/plain',
  }
  if (token) headers.authorization = `Bearer ${token}`

  let models: string[] = []
  let modelsStatus: number | null = null
  let chatStatus: number | null = null
  let completionSample = ''
  let lastError = ''
  let lastHint: string | undefined

  try {
    const { response: modelsRes, body } = await fetchJsonWithTimeout(`${endpoint}/models`, {
      headers,
      cache: 'no-store',
    }, timeoutMs)
    modelsStatus = modelsRes.status
    if (modelsRes.ok) {
      models = extractModels(body)
    } else {
      const err = describeHttpError(modelsRes.status)
      lastError = err.error
      lastHint = err.hint
    }
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      lastError = `OpenClaw models probe timed out after ${timeoutMs}ms.`
    } else {
      lastError = err?.message || 'Failed to connect to OpenClaw endpoint.'
    }
    return {
      ok: false,
      endpoint,
      wsUrl,
      authProvided,
      model: null,
      models: [],
      modelsStatus: null,
      chatStatus: null,
      error: lastError,
      hint: 'Verify the OpenClaw gateway is running and reachable at this host/port.',
    }
  }

  const model = normalizeToken(input.model) || models[0] || 'default'

  try {
    const { response: chatRes, body } = await fetchJsonWithTimeout(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      cache: 'no-store',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OPENCLAW_HEALTH_OK' }],
        stream: false,
        max_tokens: 12,
      }),
    }, timeoutMs)
    chatStatus = chatRes.status
    if (!chatRes.ok) {
      const err = describeHttpError(chatRes.status)
      lastError = err.error
      lastHint = err.hint || lastHint
    } else {
      completionSample = extractChatText(body).slice(0, 240)
    }
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      lastError = `OpenClaw chat probe timed out after ${timeoutMs}ms.`
    } else {
      lastError = err?.message || 'OpenClaw chat probe failed.'
    }
  }

  return {
    ok: !!chatStatus && chatStatus >= 200 && chatStatus < 300,
    endpoint,
    wsUrl,
    authProvided,
    model,
    models,
    modelsStatus,
    chatStatus,
    completionSample: completionSample || undefined,
    error: lastError || undefined,
    hint: lastHint,
  }
}
