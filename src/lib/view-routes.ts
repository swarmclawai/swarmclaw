import type { AppView } from '@/types'

export const DEFAULT_VIEW: AppView = 'agents'

export const VIEW_TO_PATH: Record<AppView, string> = {
  agents: '/agents',
  schedules: '/schedules',
  memory: '/memory',
  tasks: '/tasks',
  secrets: '/secrets',
  providers: '/providers',
  skills: '/skills',
  connectors: '/connectors',
  webhooks: '/webhooks',
  mcp_servers: '/mcp-servers',
  knowledge: '/knowledge',
  plugins: '/plugins',
  usage: '/usage',
  runs: '/runs',
  logs: '/logs',
  settings: '/settings',
  projects: '/projects',
}

const entries = Object.entries(VIEW_TO_PATH) as [AppView, string][]
export const PATH_TO_VIEW: Record<string, AppView> = Object.fromEntries(
  entries.map(([view, path]) => [path, view]),
) as Record<string, AppView>
