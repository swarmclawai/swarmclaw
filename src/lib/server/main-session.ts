/**
 * Returns true for sessions that participate in the main-agent-loop
 * (autonomous followups, mission tracking, etc).
 * This includes agent thread sessions and orchestrated task sessions.
 */
export function isMainLoopSession(session: any): boolean {
  if (!session || typeof session !== 'object') return false
  if (session.sessionType === 'orchestrated') return true

  const id = typeof session.id === 'string' ? session.id.trim() : ''
  if (id.startsWith('agent-thread-')) return true

  const name = typeof session.name === 'string' ? session.name.trim() : ''
  if (name.startsWith('agent-thread:')) return true

  return false
}
