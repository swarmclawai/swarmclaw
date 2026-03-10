function canUseLocalStorage(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !!window.localStorage
  } catch {
    return false
  }
}

export function safeStorageGet(key: string): string | null {
  if (!canUseLocalStorage()) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeStorageSet(key: string, value: string): boolean {
  if (!canUseLocalStorage()) return false
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeStorageRemove(key: string): boolean {
  if (!canUseLocalStorage()) return false
  try {
    window.localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function safeStorageGetJson<T>(key: string, fallback: T): T {
  const raw = safeStorageGet(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
