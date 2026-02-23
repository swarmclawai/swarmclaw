import { spawnSync } from 'child_process'

type DelegateTool = 'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'

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
  return 'opencode'
}

function delegateProviderId(delegateTool: DelegateTool): string {
  if (delegateTool === 'delegate_to_claude_code') return 'claude-cli'
  if (delegateTool === 'delegate_to_codex_cli') return 'codex-cli'
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

