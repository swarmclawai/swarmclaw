'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { getViewPath } from '@/lib/app/navigation'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { PageLoader } from '@/components/ui/page-loader'

export default function AgentsPage() {
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const router = useRouter()
  const agents = useAppStore((s) => s.agents)
  const appSettings = useAppStore((s) => s.appSettings)
  const redirected = useRef(false)

  const defaultAgent = appSettings.defaultAgentId && agents[appSettings.defaultAgentId]
    ? agents[appSettings.defaultAgentId]
    : Object.values(agents)[0] || null

  // On desktop, auto-redirect to the default (or first) agent instead of showing a placeholder
  useEffect(() => {
    if (!isDesktop || redirected.current) return
    if (defaultAgent) {
      redirected.current = true
      router.replace(getViewPath('agents', defaultAgent.id))
    }
  }, [isDesktop, defaultAgent, router])

  if (!isDesktop) return <AgentChatList />

  // Brief flash while redirecting, or no agents exist yet
  return <PageLoader />
}
