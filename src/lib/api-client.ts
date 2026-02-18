const ACCESS_KEY_STORAGE = 'sc_access_key'

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

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const key = getStoredAccessKey()
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Access-Key': key } : {}),
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch('/api' + path, opts)

  if (r.status === 401) {
    // Clear stored key on auth failure, redirect to login
    clearStoredAccessKey()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('sc_auth_required'))
    }
    throw new Error('Unauthorized — invalid access key')
  }

  const ct = r.headers.get('content-type') || ''
  if (ct.includes('json')) return r.json() as Promise<T>
  return r.text() as unknown as T
}
