import type { Session } from '@/types'

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const OBSERVABLE_PLATFORM_SESSION_OWNERS = new Set(['workbench', 'comparison-bench'])
const VISIBLE_NON_USER_SESSION_OWNERS = new Set(['system', 'swarm'])

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

export function isLocalhostBrowser(): boolean {
  if (typeof window === 'undefined') return false
  return LOCALHOST_HOSTNAMES.has(normalizeHostname(window.location.hostname))
}

export function isObservablePlatformSessionOwner(user: string | null | undefined): boolean {
  const normalized = typeof user === 'string' ? user.trim().toLowerCase() : ''
  return OBSERVABLE_PLATFORM_SESSION_OWNERS.has(normalized)
}

export function isVisibleSessionForViewer(
  session: Session,
  currentUser: string | null | undefined,
  options?: { localhost?: boolean },
): boolean {
  const owner = (session.user || '').trim().toLowerCase()
  if (!owner) return true
  if (currentUser && owner === currentUser.trim().toLowerCase()) return true
  if (VISIBLE_NON_USER_SESSION_OWNERS.has(owner)) return true
  return options?.localhost === true && isObservablePlatformSessionOwner(owner)
}

export function findLatestObservablePlatformSession(
  sessions: Record<string, Session>,
  agentId: string,
): Session | null {
  let latest: Session | null = null
  for (const session of Object.values(sessions)) {
    if (session.agentId !== agentId) continue
    if (!isObservablePlatformSessionOwner(session.user)) continue
    if (session.shortcutForAgentId) continue
    if (!latest || (session.lastActiveAt || session.createdAt || 0) > (latest.lastActiveAt || latest.createdAt || 0)) {
      latest = session
    }
  }
  return latest
}
