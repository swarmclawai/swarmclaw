const ACCESS_KEY_STORAGE = 'sc_access_key'
const DEFAULT_API_TIMEOUT_MS = 12_000
const DEFAULT_GET_RETRIES = 2
const RETRY_DELAY_BASE_MS = 300

export function getStoredAccessKey(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(ACCESS_KEY_STORAGE) || ''
}

export function setStoredAccessKey(key: string) {
  localStorage.setItem(ACCESS_KEY_STORAGE, key)
}

export function clearStoredAccessKey() {
  localStorage.removeItem(ACCESS_KEY_STORAGE)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (err as { name?: string }).name === 'AbortError'
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: { timeoutMs?: number; retries?: number },
): Promise<T> {
  const key = getStoredAccessKey()
  const timeoutMs = Math.max(1_000, Math.trunc(options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS))
  const upperMethod = method.toUpperCase()
  const retries = Math.max(0, Math.trunc(options?.retries ?? (upperMethod === 'GET' ? DEFAULT_GET_RETRIES : 0)))

  const requestInit: RequestInit = {
    method: upperMethod,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Access-Key': key } : {}),
    },
  }
  if (body) requestInit.body = JSON.stringify(body)

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout('/api' + path, requestInit, timeoutMs)

      if (r.status === 401) {
        // Clear stored key on auth failure, redirect to login
        clearStoredAccessKey()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('sc_auth_required'))
        }
        throw new Error('Unauthorized — invalid access key')
      }

      const ct = r.headers.get('content-type') || ''

      if (!r.ok) {
        if (ct.includes('json')) {
          const payload = await r.json().catch(() => null) as { error?: unknown; message?: unknown } | null
          const msg =
            (typeof payload?.error === 'string' && payload.error.trim())
            || (typeof payload?.message === 'string' && payload.message.trim())
            || `Request failed (${r.status})`
          throw new Error(msg)
        }
        const text = (await r.text().catch(() => '')).trim()
        throw new Error(text || `Request failed (${r.status})`)
      }

      if (ct.includes('json')) return r.json() as Promise<T>
      return r.text() as unknown as T
    } catch (err) {
      const isLastAttempt = attempt >= retries
      const retryable = isAbortError(err) || (err instanceof TypeError && !String(err.message || '').includes('Unauthorized'))
      if (isLastAttempt || !retryable) throw err
      await sleep(RETRY_DELAY_BASE_MS * (attempt + 1))
    }
  }
  throw new Error('Request failed')
}
