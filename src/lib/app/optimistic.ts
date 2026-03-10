/**
 * Generic optimistic mutation helper for Zustand stores.
 * Applies a patch immediately, then fires the API call.
 * On failure, rolls back to the previous state and calls an optional error handler.
 */
export async function optimistic<T>(
  storeSetter: (updater: (state: T) => Partial<T>) => void,
  patch: (state: T) => Partial<T>,
  apiCall: () => Promise<unknown>,
  rollback: (state: T) => Partial<T>,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  // Apply optimistic update
  storeSetter(patch)

  try {
    await apiCall()
    return true
  } catch (err: unknown) {
    // Rollback
    storeSetter(rollback)
    if (onError) onError(err)
    return false
  }
}
