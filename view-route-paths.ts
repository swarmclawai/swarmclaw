import type { AppView } from './src/types'

/**
 * Single source of truth for app-shell view URL paths.
 * Used by both client-side view routing and Next.js rewrites for direct URL access.
 */
export const VIEW_ROUTE_PATHS: Record<AppView, string> = {
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

export const DIRECT_NAV_SEGMENTS = Object.values(VIEW_ROUTE_PATHS)
  .filter((path) => path !== '/')
  .map((path) => path.slice(1))
