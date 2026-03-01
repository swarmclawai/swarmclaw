const inflight = new Map<string, Promise<Response>>()

/**
 * Deduplicates concurrent GET requests to the same URL.
 * Non-GET requests pass through without dedup.
 */
export function dedupedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return fetch(url, init)

  const existing = inflight.get(url)
  if (existing) return existing

  const promise = fetch(url, init).finally(() => {
    inflight.delete(url)
  })

  inflight.set(url, promise)
  return promise
}
