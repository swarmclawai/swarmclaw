import { spawnSync } from 'child_process'

type DelegateTool = 'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli' | 'delegate_to_gemini_cli'

interface ProviderHealthState {
  failures: number
  lastError?: string
  lastFailureAt?: number
  lastSuccessAt?: number
  cooldownUntil?: number
}

const gk = '__swarmclaw_provider_health__' as const
const states: Map<string, ProviderHealthState> =
  (globalThis as any)[gk] ?? ((globalThis as any)[gk] = new Map<string, ProviderHealthState>())

const cliCheckCache = new Map<string, { at: number; ok: boolean }>()
const CLI_CHECK_TTL_MS = 30_000

function commandExists(binary: string): boolean {
  const now = Date.now()
  const cached = cliCheckCache.get(binary)
  if (cached && now - cached.at < CLI_CHECK_TTL_MS) return cached.ok
  const probe = spawnSync('/bin/zsh', ['-lc', `command -v ${binary} >/dev/null 2>&1`], { timeout: 2000 })
  const ok = (probe.status ?? 1) === 0
  cliCheckCache.set(binary, { at: now, ok })
  return ok
}

function cooldownMsForFailures(failures: number): number {
  const clamped = Math.max(1, Math.min(8, failures))
  return Math.min(5 * 60_000, 10_000 * (2 ** (clamped - 1)))
}

export function markProviderFailure(providerId: string, error: string): void {
  const now = Date.now()
  const prev = states.get(providerId) || { failures: 0 }
  const failures = Math.min(50, (prev.failures || 0) + 1)
  states.set(providerId, {
    failures,
    lastError: error.slice(0, 500),
    lastFailureAt: now,
    lastSuccessAt: prev.lastSuccessAt,
    cooldownUntil: now + cooldownMsForFailures(failures),
  })
}

export function markProviderSuccess(providerId: string): void {
  const now = Date.now()
  const prev = states.get(providerId) || { failures: 0 }
  states.set(providerId, {
    failures: 0,
    lastError: prev.lastError,
    lastFailureAt: prev.lastFailureAt,
    lastSuccessAt: now,
    cooldownUntil: undefined,
  })
}

export function isProviderCoolingDown(providerId: string): boolean {
  const state = states.get(providerId)
  if (!state?.cooldownUntil) return false
  return Date.now() < state.cooldownUntil
}

function delegateBinary(delegateTool: DelegateTool): string {
  if (delegateTool === 'delegate_to_claude_code') return 'claude'
  if (delegateTool === 'delegate_to_codex_cli') return 'codex'
  if (delegateTool === 'delegate_to_gemini_cli') return 'gemini'
  return 'opencode'
}

function delegateProviderId(delegateTool: DelegateTool): string {
  if (delegateTool === 'delegate_to_claude_code') return 'claude-cli'
  if (delegateTool === 'delegate_to_codex_cli') return 'codex-cli'
  if (delegateTool === 'delegate_to_gemini_cli') return 'gemini-cli'
  return 'opencode-cli'
}

export function rankDelegatesByHealth(order: DelegateTool[]): DelegateTool[] {
  const seen = new Set<DelegateTool>()
  const deduped = order.filter((tool) => {
    if (seen.has(tool)) return false
    seen.add(tool)
    return true
  })
  return deduped.sort((a, b) => {
    const aBinOk = commandExists(delegateBinary(a))
    const bBinOk = commandExists(delegateBinary(b))
    if (aBinOk !== bBinOk) return aBinOk ? -1 : 1

    const aCool = isProviderCoolingDown(delegateProviderId(a))
    const bCool = isProviderCoolingDown(delegateProviderId(b))
    if (aCool !== bCool) return aCool ? 1 : -1

    const aState = states.get(delegateProviderId(a))
    const bState = states.get(delegateProviderId(b))
    const aFails = aState?.failures || 0
    const bFails = bState?.failures || 0
    if (aFails !== bFails) return aFails - bFails
    return 0
  })
}

export function getProviderHealthSnapshot(): Record<string, ProviderHealthState & { coolingDown: boolean }> {
  const out: Record<string, ProviderHealthState & { coolingDown: boolean }> = {}
  for (const [providerId, state] of states.entries()) {
    out[providerId] = {
      ...state,
      coolingDown: isProviderCoolingDown(providerId),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Lightweight provider ping functions (extracted from check-provider/route.ts)
// ---------------------------------------------------------------------------

const PING_TIMEOUT_MS = 8_000

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) return parsed.error.message.trim()
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch { /* non-JSON */ }
  return text.slice(0, 300).trim() || fallback
}

export const OPENAI_COMPATIBLE_DEFAULTS: Record<string, { name: string; defaultEndpoint: string }> = {
  openai: { name: 'OpenAI', defaultEndpoint: 'https://api.openai.com/v1' },
  google: { name: 'Google Gemini', defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  deepseek: { name: 'DeepSeek', defaultEndpoint: 'https://api.deepseek.com/v1' },
  groq: { name: 'Groq', defaultEndpoint: 'https://api.groq.com/openai/v1' },
  together: { name: 'Together AI', defaultEndpoint: 'https://api.together.xyz/v1' },
  mistral: { name: 'Mistral AI', defaultEndpoint: 'https://api.mistral.ai/v1' },
  xai: { name: 'xAI (Grok)', defaultEndpoint: 'https://api.x.ai/v1' },
  fireworks: { name: 'Fireworks AI', defaultEndpoint: 'https://api.fireworks.ai/inference/v1' },
}

export async function pingOpenAiCompatible(
  apiKey: string,
  endpoint: string,
): Promise<{ ok: boolean; message: string }> {
  const normalizedEndpoint = endpoint.replace(/\/+$/, '')
  const res = await fetch(`${normalizedEndpoint}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `Provider returned ${res.status}.`)
    return { ok: false, message: detail }
  }
  return { ok: true, message: 'Connected.' }
}

export async function pingAnthropic(apiKey: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `Anthropic returned ${res.status}.`)
    return { ok: false, message: detail }
  }
  return { ok: true, message: 'Connected to Anthropic.' }
}

export async function pingOllama(endpoint: string): Promise<{ ok: boolean; message: string }> {
  const normalizedEndpoint = (endpoint || 'http://localhost:11434').replace(/\/+$/, '')
  const res = await fetch(`${normalizedEndpoint}/api/tags`, {
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) {
    const detail = await parseErrorMessage(res, `Ollama returned ${res.status}.`)
    return { ok: false, message: detail }
  }
  return { ok: true, message: 'Connected to Ollama.' }
}

export async function pingOpenClaw(
  apiKey: string | undefined,
  endpoint: string,
): Promise<{ ok: boolean; message: string }> {
  const { wsConnect } = await import('@/lib/providers/openclaw')
  let url = (endpoint || 'http://localhost:18789').replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(url)) url = `http://${url}`
  const wsUrl = url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  const result = await wsConnect(wsUrl, apiKey || undefined, true, PING_TIMEOUT_MS)
  if (result.ws) try { result.ws.close() } catch { /* ignore */ }
  return { ok: result.ok, message: result.ok ? 'Connected to OpenClaw.' : result.message }
}

/**
 * Ping a provider to check reachability. Returns `{ ok, message }`.
 * Skips CLI-based providers (claude-cli, codex-cli, opencode-cli, gemini-cli) — returns ok.
 */
export async function pingProvider(
  provider: string,
  apiKey: string | undefined,
  endpoint: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli']
  if (CLI_PROVIDERS.includes(provider)) return { ok: true, message: 'CLI provider — skipped.' }

  try {
    if (provider === 'anthropic') {
      if (!apiKey) return { ok: false, message: 'No API key configured.' }
      return await pingAnthropic(apiKey)
    }
    if (provider === 'ollama') {
      return await pingOllama(endpoint || 'http://localhost:11434')
    }
    if (provider === 'openclaw') {
      return await pingOpenClaw(apiKey, endpoint || 'http://localhost:18789')
    }
    // OpenAI-compatible providers (openai, google, deepseek, groq, together, mistral, xai, fireworks, custom)
    const defaults = OPENAI_COMPATIBLE_DEFAULTS[provider]
    const resolvedEndpoint = endpoint || defaults?.defaultEndpoint
    if (!resolvedEndpoint) return { ok: false, message: `No endpoint for provider "${provider}".` }
    if (!apiKey) return { ok: false, message: 'No API key configured.' }
    return await pingOpenAiCompatible(apiKey, resolvedEndpoint)
  } catch (err: unknown) {
    const msg = err instanceof Error && err.name === 'TimeoutError'
      ? 'Connection timed out.'
      : (err instanceof Error ? err.message : String(err))
    return { ok: false, message: msg }
  }
}
