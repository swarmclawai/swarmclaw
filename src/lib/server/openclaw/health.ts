import { deriveOpenClawWsUrl, normalizeOpenClawEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { wsConnect } from '@/lib/providers/openclaw'
import { decryptKey, loadCredentials, loadGatewayProfiles, saveGatewayProfiles } from '../storage'
import { notify } from '../ws-hub'
import type { GatewayProfile } from '@/types'

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
  wsConnected: boolean
  httpCompatible: boolean | null
  authProvided: boolean
  model: string | null
  models: string[]
  modelsStatus: number | null
  chatStatus: number | null
  message: string
  completionSample?: string
  warning?: string
  error?: string
  hint?: string
}

export interface OpenClawHttpProbeStatus {
  httpCompatible: boolean
  warning?: string
  hint?: string
  modelsEndpointOptional: boolean
}

type JsonRecord = Record<string, unknown>

function normalizeToken(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function getErrorName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name
  const record = asRecord(err)
  return typeof record?.name === 'string' ? record.name : undefined
}

function getErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message
  const record = asRecord(err)
  return typeof record?.message === 'string' ? record.message : undefined
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

function extractModels(payload: unknown): string[] {
  const payloadRecord = asRecord(payload)
  const models = Array.isArray(payloadRecord?.data) ? payloadRecord.data : []
  return models
    .map((item) => {
      const record = asRecord(item)
      return typeof record?.id === 'string' ? record.id.trim() : ''
    })
    .filter(Boolean)
}

function extractChatText(payload: unknown): string {
  const payloadRecord = asRecord(payload)
  const choices = Array.isArray(payloadRecord?.choices) ? payloadRecord.choices : []
  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice?.message)
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = asRecord(block)
        if (typeof record?.text === 'string') return record.text
        if (typeof record?.content === 'string') return record.content
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

function describeGatewayError(errorCode: string | undefined, message: string): { error: string; hint?: string } {
  if (errorCode === 'AUTH_TOKEN_MISSING') {
    return {
      error: message || 'OpenClaw gateway requires a token.',
      hint: 'Attach an OpenClaw credential or token before running the gateway health check.',
    }
  }
  if (errorCode === 'AUTH_TOKEN_INVALID') {
    return {
      error: message || 'OpenClaw gateway rejected the supplied token.',
      hint: 'Update the saved OpenClaw token or re-pair this gateway with a valid operator token.',
    }
  }
  if (errorCode === 'PAIRING_REQUIRED') {
    return {
      error: message || 'OpenClaw gateway requires device pairing.',
      hint: 'Approve this SwarmClaw device in the OpenClaw gateway before using it from the app.',
    }
  }
  if (errorCode === 'DEVICE_AUTH_INVALID') {
    return {
      error: message || 'OpenClaw gateway rejected the saved device identity.',
      hint: 'Re-pair this SwarmClaw device with the gateway or reset the saved device identity and try again.',
    }
  }
  return {
    error: message || 'Failed to connect to OpenClaw gateway.',
    hint: 'Verify the OpenClaw gateway is running and reachable at this host/port.',
  }
}

function pushIssue(issues: string[], next: string | undefined): void {
  if (typeof next !== 'string') return
  const value = next.trim()
  if (!value) return
  issues.push(value)
}

function isModelsEndpointWarning(issue: string): boolean {
  return issue.startsWith('OpenAI-compatible models endpoint failed:')
    || issue.startsWith('OpenAI-compatible models probe timed out')
}

export function resolveOpenClawHttpProbeStatus(input: {
  modelsStatus: number | null
  chatStatus: number | null
  warnings: string[]
  warningHint?: string
}): OpenClawHttpProbeStatus {
  const modelsOk = !!input.modelsStatus && input.modelsStatus >= 200 && input.modelsStatus < 300
  const chatOk = !!input.chatStatus && input.chatStatus >= 200 && input.chatStatus < 300
  const modelsEndpointOptional = chatOk && input.modelsStatus === 404
  const filteredWarnings = modelsEndpointOptional
    ? input.warnings.filter((issue) => !isModelsEndpointWarning(issue))
    : input.warnings
  const warning = filteredWarnings.join(' ') || undefined

  return {
    httpCompatible: chatOk && (modelsOk || modelsEndpointOptional),
    warning,
    hint: warning ? input.warningHint : undefined,
    modelsEndpointOptional,
  }
}

function summarizeOpenClawHealth(input: {
  ok: boolean
  models: string[]
  modelsStatus: number | null
  httpCompatible: boolean | null
  modelsEndpointOptional?: boolean
  warning?: string
  error?: string
}): string {
  if (!input.ok) return input.error || 'OpenClaw gateway health check failed.'
  const parts = ['Connected to OpenClaw gateway via WebSocket.']
  if (input.modelsStatus && input.modelsStatus >= 200 && input.modelsStatus < 300) {
    parts.push(
      input.models.length > 0
        ? `${input.models.length} model${input.models.length === 1 ? '' : 's'} visible.`
        : 'HTTP models endpoint responded with no models.',
    )
  }
  if (input.httpCompatible === true) {
    if (input.modelsEndpointOptional) {
      parts.push('OpenAI-compatible chat checks passed. This gateway does not advertise `/v1/models`, which is acceptable for OpenClaw.')
    } else {
      parts.push('OpenAI-compatible HTTP checks passed.')
    }
  } else if (input.warning) {
    parts.push(input.warning)
    parts.push('SwarmClaw can still use this gateway over WebSocket.')
  }
  return parts.join(' ')
}

function createTimeoutError(message: string): Error {
  const timeoutErr = new Error(message) as Error & { name: string }
  timeoutErr.name = 'TimeoutError'
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

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; body: unknown }> {
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
    let body: unknown = {}
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = {}
      }
    }
    return { response, body }
  } catch (err: unknown) {
    if (getErrorName(err) === 'AbortError') throw createTimeoutError(`Request timed out after ${timeoutMs}ms`)
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
  let warningHint: string | undefined
  const warnings: string[] = []

  const wsResult = await wsConnect(wsUrl, token || undefined, true, timeoutMs)
  if (wsResult.ws) {
    try { wsResult.ws.close() } catch { /* noop */ }
  }
  if (!wsResult.ok) {
    const gatewayError = describeGatewayError(wsResult.errorCode, wsResult.message)
    return {
      ok: false,
      endpoint,
      wsUrl,
      wsConnected: false,
      httpCompatible: null,
      authProvided,
      model: null,
      models: [],
      modelsStatus: null,
      chatStatus: null,
      message: gatewayError.error,
      error: gatewayError.error,
      hint: gatewayError.hint,
    }
  }

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
      pushIssue(warnings, `OpenAI-compatible models endpoint failed: ${err.error}`)
      warningHint = err.hint || warningHint
    }
  } catch (err: unknown) {
    pushIssue(
      warnings,
      getErrorName(err) === 'TimeoutError'
        ? `OpenAI-compatible models probe timed out after ${timeoutMs}ms.`
        : (getErrorMessage(err) || 'Failed to connect to the OpenAI-compatible models endpoint.'),
    )
    warningHint = 'The gateway is reachable, but the optional HTTP `/v1/models` endpoint did not respond normally.'
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
      pushIssue(warnings, `OpenAI-compatible chat endpoint failed: ${err.error}`)
      warningHint = err.hint || warningHint
    } else {
      completionSample = extractChatText(body).slice(0, 240)
    }
  } catch (err: unknown) {
    pushIssue(
      warnings,
      getErrorName(err) === 'TimeoutError'
        ? `OpenAI-compatible chat probe timed out after ${timeoutMs}ms.`
        : (getErrorMessage(err) || 'OpenAI-compatible chat probe failed.'),
    )
    warningHint = warningHint || 'The gateway is reachable, but the optional HTTP `/v1/chat/completions` endpoint did not respond normally.'
  }

  const http = resolveOpenClawHttpProbeStatus({
    modelsStatus,
    chatStatus,
    warnings,
    warningHint,
  })
  const message = summarizeOpenClawHealth({
    ok: true,
    models,
    modelsStatus,
    httpCompatible: http.httpCompatible,
    modelsEndpointOptional: http.modelsEndpointOptional,
    warning: http.warning,
  })

  return {
    ok: true,
    endpoint,
    wsUrl,
    wsConnected: true,
    httpCompatible: http.httpCompatible,
    authProvided,
    model,
    models,
    modelsStatus,
    chatStatus,
    message,
    completionSample: completionSample || undefined,
    warning: http.warning,
    hint: http.hint,
  }
}

export function persistGatewayHealthResult(
  id: string,
  result: OpenClawHealthResult,
  now = Date.now(),
): GatewayProfile | null {
  const gateways = loadGatewayProfiles()
  const gateway = gateways[id]
  if (!gateway) return null

  gateway.status = result.ok ? 'healthy' : (result.authProvided ? 'degraded' : 'offline')
  gateway.lastCheckedAt = now
  gateway.lastError = result.ok ? null : (result.error || result.hint || 'Gateway health check failed.')
  gateway.lastModelCount = Array.isArray(result.models) ? result.models.length : 0
  gateway.deployment = {
    ...(gateway.deployment || {}),
    lastVerifiedAt: now,
    lastVerifiedOk: result.ok,
    lastVerifiedMessage: result.ok
      ? result.message
      : (result.error || result.hint || 'Gateway health check failed.'),
  }
  gateway.updatedAt = now
  saveGatewayProfiles(gateways)
  notify('gateways')
  return gateway
}
