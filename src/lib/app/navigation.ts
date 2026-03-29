'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { AppView } from '@/types'

const VIEW_TO_PATH: Record<AppView, string> = {
  home: '/home',
  agents: '/agents',
  org_chart: '/org-chart',
  inbox: '/inbox',
  chatrooms: '/chatrooms',
  protocols: '/protocols',
  schedules: '/schedules',
  memory: '/memory',

  tasks: '/tasks',
  secrets: '/secrets',
  wallets: '/wallets',
  providers: '/providers',
  skills: '/skills',
  connectors: '/connectors',
  webhooks: '/webhooks',
  mcp_servers: '/mcp-servers',
  knowledge: '/knowledge',
  logs: '/logs',
  extensions: '/extensions',
  usage: '/usage',
  runs: '/runs',
  autonomy: '/autonomy',
  settings: '/settings',
  projects: '/projects',
  activity: '/activity',
}

/** Build a URL path for a given view, optionally with an entity ID. */
export function getViewPath(view: AppView, id?: string | null): string {
  const base = VIEW_TO_PATH[view]
  if (id && (view === 'agents' || view === 'chatrooms')) {
    return `${base}/${encodeURIComponent(id)}`
  }
  return base
}

/** Map a pathname back to an AppView. Returns null for unknown paths. */
export function pathToView(pathname: string): AppView | null {
  for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
    if (pathname === path || pathname.startsWith(path + '/')) {
      return view as AppView
    }
  }
  return null
}

/** Hook for navigating between views using Next.js router. */
export function useNavigate() {
  const router = useRouter()

  const navigateTo = useCallback((view: AppView, id?: string | null) => {
    router.push(getViewPath(view, id))
  }, [router])

  return navigateTo
}
