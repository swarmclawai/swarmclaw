const MIN_TIMEOUT_MS = 1_000

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const boundedTimeout = Math.max(MIN_TIMEOUT_MS, Math.trunc(timeoutMs))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), boundedTimeout)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
