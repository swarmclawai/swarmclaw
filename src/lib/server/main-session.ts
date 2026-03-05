const MAIN_SESSION_NAME = '__main__'

export function isProtectedMainSession(session: any): boolean {
  if (!session || typeof session !== 'object') return false
  if (session.mainSession === true) return true
  if (session.sessionType === 'orchestrated') return true

  const id = typeof session.id === 'string' ? session.id.trim() : ''
  if (id.startsWith('main-')) return true
  if (id.startsWith('agent-thread-')) return true

  const name = typeof session.name === 'string' ? session.name.trim() : ''
  if (name === MAIN_SESSION_NAME) return true
  if (name.startsWith('agent-thread:')) return true

  return false
}

export function ensureMainSessionFlag(session: any): void {
  if (!session || typeof session !== 'object') return
  if (isProtectedMainSession(session)) {
    session.mainSession = true
  }
}
