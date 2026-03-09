/**
 * Memoisation layer for Zustand store loaders.
 *
 * Every async loader (loadSessions, loadTasks, loadProviders, …) fetches data
 * from the API and calls `set()`. Because the API always returns fresh object
 * references, `set()` unconditionally replaces the store value, which triggers
 * re-renders in *every* component that subscribes to that slice — even when the
 * data hasn't changed.
 *
 * `setIfChanged` keeps a lightweight JSON fingerprint of the last value written
 * for each store key. If the new value produces the same fingerprint, the
 * `set()` call is skipped entirely, preventing the render cascade.
 */

const fingerprints = new Map<string, string>()

/**
 * Call Zustand `set()` only when the value for `key` has actually changed.
 * Returns `true` if `set()` was called, `false` if skipped.
 */
export function setIfChanged<S>(
  set: (partial: Partial<S>) => void,
  key: keyof S & string,
  value: S[keyof S],
): boolean {
  const json = JSON.stringify(value)
  if (fingerprints.get(key) === json) return false
  fingerprints.set(key, json)
  set({ [key]: value } as Partial<S>)
  return true
}

/**
 * Invalidate the fingerprint for a key so the next `setIfChanged` call
 * for that key will always write. Useful after local mutations (optimistic
 * updates, removes) that change the store without going through the loader.
 */
export function invalidateFingerprint(key: string): void {
  fingerprints.delete(key)
}
