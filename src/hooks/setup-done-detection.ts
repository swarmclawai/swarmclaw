/**
 * Pure function extracted from use-app-bootstrap.ts for testability.
 * Determines whether initial setup is considered complete.
 */
export function resolveSetupDone(
  settings: { setupCompleted?: boolean },
  creds: Record<string, unknown>,
  bothFailed: boolean,
): boolean {
  if (bothFailed) return true
  const hasCreds = Object.keys(creds).length > 0
  return settings.setupCompleted === true || hasCreds
}
