import type { AppView } from '@/types'

export const DEFAULT_VIEW: AppView = 'home'

export const VIEW_TO_PATH: Record<AppView, string> = {
  home: '/',
  agents: '/agents',
  chatrooms: '/chatrooms',
  schedules: '/schedules',
  memory: '/memory',
  tasks: '/tasks',
  approvals: '/approvals',
  secrets: '/secrets',
  providers: '/providers',
  skills: '/skills',
  connectors: '/connectors',
  webhooks: '/webhooks',
  mcp_servers: '/mcp-servers',
  knowledge: '/knowledge',
  plugins: '/plugins',
  usage: '/usage',
  wallets: '/wallets',
  runs: '/runs',
  logs: '/logs',
  settings: '/settings',
  projects: '/projects',
  activity: '/activity',
}

const entries = Object.entries(VIEW_TO_PATH) as [AppView, string][]
export const PATH_TO_VIEW: Record<string, AppView> = Object.fromEntries(
  entries.map(([view, path]) => [path, view]),
) as Record<string, AppView>

/** Views that support deep-linking to a specific entity by ID */
const VIEWS_WITH_ID = new Set<AppView>(['agents', 'chatrooms'])

// Sorted longest-first so "/mcp-servers" matches before "/" etc.
const sortedPaths = entries
  .map(([view, path]) => ({ view, path }))
  .sort((a, b) => b.path.length - a.path.length)

/** Parse a pathname into { view, id }. Returns null for unknown paths. */
export function parsePath(pathname: string): { view: AppView; id: string | null } | null {
  // Exact match first (no trailing ID)
  const exact = PATH_TO_VIEW[pathname]
  if (exact) return { view: exact, id: null }

  // Prefix match: "/agents/abc123" → view=agents, id=abc123
  for (const { view, path } of sortedPaths) {
    if (pathname.startsWith(path + '/')) {
      const rest = pathname.slice(path.length + 1)
      if (rest && !rest.includes('/') && VIEWS_WITH_ID.has(view)) {
        try {
          return { view, id: decodeURIComponent(rest) }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Build a URL path for a view, optionally with an entity ID. */
export function buildPath(view: AppView, id?: string | null): string {
  const base = VIEW_TO_PATH[view]
  if (id && VIEWS_WITH_ID.has(view)) return `${base}/${encodeURIComponent(id)}`
  return base
}
