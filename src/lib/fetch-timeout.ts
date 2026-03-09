const MIN_TIMEOUT_MS = 1_000

function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Request timed out after ${timeoutMs}ms`)
  error.name = 'TimeoutError'
  return error
}

function abortWithReason(controller: AbortController, reason: unknown): void {
  try {
    controller.abort(reason)
  } catch {
    controller.abort()
  }
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)

  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  const abortFrom = (signal: AbortSignal) => {
    for (const [candidate, listener] of listeners.entries()) {
      candidate.removeEventListener('abort', listener)
    }
    abortWithReason(controller, signal.reason)
  }

  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal)
      break
    }
    const listener = () => abortFrom(signal)
    listeners.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
  }

  return controller.signal
}

export function isAbortError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'
}

export function isTimeoutError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'TimeoutError'
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const boundedTimeout = Math.max(MIN_TIMEOUT_MS, Math.trunc(timeoutMs))
  const timeoutController = new AbortController()
  const timeoutError = createTimeoutError(boundedTimeout)
  const signal = init.signal
    ? combineAbortSignals([init.signal, timeoutController.signal])
    : timeoutController.signal
  const timer = setTimeout(() => abortWithReason(timeoutController, timeoutError), boundedTimeout)

  try {
    return await fetch(input, { ...init, signal })
  } catch (err) {
    if (timeoutController.signal.aborted && isTimeoutError(timeoutController.signal.reason)) {
      throw timeoutController.signal.reason
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
