export function isDirectConnectorSession(session?: unknown): boolean {
  if (!session || typeof session !== 'object') return false
  const record = session as Record<string, unknown>
  const user = typeof record.user === 'string' ? record.user.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  return user === 'connector' || name.startsWith('connector:')
}
