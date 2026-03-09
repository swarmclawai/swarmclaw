import { connectorRuntimeState, type ConnectorReconnectState } from './runtime-state'

export type { ConnectorReconnectState }

interface ConnectorReconnectPolicy {
  initialBackoffMs?: number
  maxBackoffMs?: number
  maxAttempts?: number
}

export const connectorReconnectStateStore: Map<string, ConnectorReconnectState> =
  connectorRuntimeState.reconnectStates

const RECONNECT_INITIAL_BACKOFF_MS = 1_000
const RECONNECT_MAX_BACKOFF_MS = 5 * 60 * 1_000
const RECONNECT_MAX_ATTEMPTS = 10

export function createConnectorReconnectState(
  init: Partial<ConnectorReconnectState> = {},
  policy: ConnectorReconnectPolicy = {},
): ConnectorReconnectState {
  return {
    attempts: init.attempts ?? 0,
    lastAttemptAt: init.lastAttemptAt ?? 0,
    nextRetryAt: init.nextRetryAt ?? 0,
    backoffMs: init.backoffMs ?? policy.initialBackoffMs ?? RECONNECT_INITIAL_BACKOFF_MS,
    error: init.error ?? '',
    exhausted: init.exhausted ?? false,
  }
}

export function advanceConnectorReconnectState(
  previous: ConnectorReconnectState,
  error: string,
  now = Date.now(),
  policy: ConnectorReconnectPolicy = {},
): ConnectorReconnectState {
  const initialBackoffMs = policy.initialBackoffMs ?? RECONNECT_INITIAL_BACKOFF_MS
  const maxBackoffMs = policy.maxBackoffMs ?? RECONNECT_MAX_BACKOFF_MS
  const maxAttempts = policy.maxAttempts ?? RECONNECT_MAX_ATTEMPTS
  const attempts = previous.attempts + 1
  const backoffMs = Math.min(maxBackoffMs, initialBackoffMs * (2 ** Math.max(0, attempts - 1)))
  return {
    attempts,
    lastAttemptAt: now,
    nextRetryAt: now + backoffMs,
    backoffMs,
    error,
    exhausted: attempts >= maxAttempts,
  }
}

export function clearReconnectState(connectorId: string): void {
  connectorReconnectStateStore.delete(connectorId)
}

export function setReconnectState(connectorId: string, state: ConnectorReconnectState): void {
  connectorReconnectStateStore.set(connectorId, state)
}

export function getReconnectState(connectorId: string): ConnectorReconnectState | null {
  return connectorReconnectStateStore.get(connectorId) ?? null
}

export function getAllReconnectStates(): Record<string, ConnectorReconnectState> {
  const out: Record<string, ConnectorReconnectState> = {}
  for (const [id, state] of connectorReconnectStateStore.entries()) {
    out[id] = { ...state }
  }
  return out
}
