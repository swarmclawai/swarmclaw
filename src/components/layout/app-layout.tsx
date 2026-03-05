'use client'

import { Component, useState, useEffect, useCallback, useMemo } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useSwipe } from '@/hooks/use-swipe'
import { Avatar } from '@/components/shared/avatar'
import { SettingsPage } from '@/components/shared/settings/settings-page'
import { AgentList } from '@/components/agents/agent-list'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { AgentSheet } from '@/components/agents/agent-sheet'
import { ScheduleList } from '@/components/schedules/schedule-list'
import { ScheduleSheet } from '@/components/schedules/schedule-sheet'
import { MemoryAgentList } from '@/components/memory/memory-agent-list'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { MemoryBrowser } from '@/components/memory/memory-browser'
import { TaskList } from '@/components/tasks/task-list'
import { TaskSheet } from '@/components/tasks/task-sheet'
import { TaskBoard } from '@/components/tasks/task-board'
import { ApprovalsPanel } from '@/components/tasks/approvals-panel'
import { SecretsList } from '@/components/secrets/secrets-list'
import { SecretSheet } from '@/components/secrets/secret-sheet'
import { ProviderList } from '@/components/providers/provider-list'
import { ProviderSheet } from '@/components/providers/provider-sheet'
import { SkillList } from '@/components/skills/skill-list'
import { SkillSheet } from '@/components/skills/skill-sheet'
import { ConnectorList } from '@/components/connectors/connector-list'
import { ConnectorSheet } from '@/components/connectors/connector-sheet'
import { ChatroomList } from '@/components/chatrooms/chatroom-list'
import { ChatroomView } from '@/components/chatrooms/chatroom-view'
import { ChatroomSheet } from '@/components/chatrooms/chatroom-sheet'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { WebhookList } from '@/components/webhooks/webhook-list'
import { WebhookSheet } from '@/components/webhooks/webhook-sheet'
import { LogList } from '@/components/logs/log-list'
import { McpServerList } from '@/components/mcp-servers/mcp-server-list'
import { McpServerSheet } from '@/components/mcp-servers/mcp-server-sheet'
import { KnowledgeList } from '@/components/knowledge/knowledge-list'
import { KnowledgeSheet } from '@/components/knowledge/knowledge-sheet'
import { PluginList } from '@/components/plugins/plugin-list'
import { PluginSheet } from '@/components/plugins/plugin-sheet'
import { RunList } from '@/components/runs/run-list'
import { ActivityFeed } from '@/components/activity/activity-feed'
import { MetricsDashboard } from '@/components/usage/metrics-dashboard'
import { WalletPanel } from '@/components/wallets/wallet-panel'
import { ProjectList } from '@/components/projects/project-list'
import { ProjectDetail } from '@/components/projects/project-detail'
import { ProjectSheet } from '@/components/projects/project-sheet'
import { SearchDialog } from '@/components/shared/search-dialog'
import { AgentSwitchDialog } from '@/components/shared/agent-switch-dialog'
import { KeyboardShortcutsDialog } from '@/components/shared/keyboard-shortcuts-dialog'
import { ProfileSheet } from '@/components/shared/profile-sheet'
import { HomeView } from '@/components/home/home-view'
import { NetworkBanner } from './network-banner'
import { UpdateBanner } from './update-banner'
import { MobileHeader } from './mobile-header'
import { CommandPalette } from '@/components/shared/command-palette'
import { DaemonIndicator } from './daemon-indicator'
import { NotificationCenter } from '@/components/shared/notification-center'
import { ChatArea } from '@/components/chat/chat-area'
import { CanvasPanel } from '@/components/canvas/canvas-panel'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { api } from '@/lib/api-client'
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage'
import { useApprovalStore } from '@/stores/use-approval-store'
import { useWs } from '@/hooks/use-ws'
import type { AppView } from '@/types'

const RAIL_EXPANDED_KEY = 'sc_rail_expanded'
const STAR_NOTIFICATION_KEY = 'sc_star_notification_v1'
const GITHUB_REPO_URL = 'https://github.com/swarmclawai/swarmclaw'

export function AppLayout() {
  const currentUser = useAppStore((s) => s.currentUser)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const activeView = useAppStore((s) => s.activeView)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setSecretSheetOpen = useAppStore((s) => s.setSecretSheetOpen)
  const setProviderSheetOpen = useAppStore((s) => s.setProviderSheetOpen)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setConnectorSheetOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const setWebhookSheetOpen = useAppStore((s) => s.setWebhookSheetOpen)
  const setMcpServerSheetOpen = useAppStore((s) => s.setMcpServerSheetOpen)
  const setKnowledgeSheetOpen = useAppStore((s) => s.setKnowledgeSheetOpen)
  const setPluginSheetOpen = useAppStore((s) => s.setPluginSheetOpen)
  const setProjectSheetOpen = useAppStore((s) => s.setProjectSheetOpen)
  const tasks = useAppStore((s) => s.tasks)
  const plugins = useAppStore((s) => s.plugins)
  const loadPlugins = useAppStore((s) => s.loadPlugins)
  const approvals = useAppStore((s) => s.approvals)
  const loadApprovals = useAppStore((s) => s.loadApprovals)
  const execApprovals = useApprovalStore((s) => s.approvals)
  const loadExecApprovals = useApprovalStore((s) => s.loadApprovals)
  const pruneExecApprovals = useApprovalStore((s) => s.pruneExpired)
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const hasSelectedSession = !!(currentSessionId && sessions[currentSessionId])
  
  const pendingApprovalCount = useMemo(() => {
    const taskCount = Object.values(tasks).filter((t) => t.pendingApproval).length
    const sessionCount = Object.values(approvals).filter((a) => a.status === 'pending').length
    const execCount = Object.keys(execApprovals).length
    return taskCount + sessionCount + execCount
  }, [tasks, approvals, execApprovals])

  useEffect(() => {
    loadApprovals()
    void loadExecApprovals()
    const interval = setInterval(() => {
      loadApprovals()
      void loadExecApprovals()
      pruneExecApprovals()
    }, 10000)
    return () => clearInterval(interval)
  }, [loadApprovals, loadExecApprovals, pruneExecApprovals])

  useWs('approvals', loadApprovals, 10000)
  useWs('openclaw:approvals', () => {
    void loadExecApprovals()
    pruneExecApprovals()
  }, 10000)

  const appSettings = useAppStore((s) => s.appSettings)
  const [agentViewMode, setAgentViewMode] = useState<'chat' | 'config'>('chat')
  const [profileSheetOpen, setProfileSheetOpen] = useState(false)
  const [canvasDismissedFor, setCanvasDismissedFor] = useState<string | null>(null)

  const handleShortcutKey = useCallback((e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    // Cmd+N / Ctrl+N — new chat
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      const state = useAppStore.getState()
      const allAgents = Object.values(state.agents).filter((a) => !a.trashedAt)
      const target = allAgents.find((a) => a.id === 'default') || allAgents[0]
      if (target) void state.setCurrentAgent(target.id)
      return
    }
    // Cmd+Shift+T / Ctrl+Shift+T — jump to tasks
    if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault()
      useAppStore.getState().setActiveView('tasks')
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [handleShortcutKey])

  useEffect(() => {
    if (safeStorageGet(STAR_NOTIFICATION_KEY)) return
    safeStorageSet(STAR_NOTIFICATION_KEY, '1')
    void api('POST', '/notifications', {
      type: 'info',
      title: 'Enjoying SwarmClaw?',
      message: 'If SwarmClaw helps your workflow, please star the GitHub repo to support the project.',
      actionLabel: 'Star on GitHub',
      actionUrl: GITHUB_REPO_URL,
      entityType: 'support',
      entityId: 'github-star',
    }).then(() => {
      void useAppStore.getState().loadNotifications()
    }).catch(() => {})
  }, [])

  // Apply theme hue on mount/change
  useEffect(() => {
    const hue = appSettings.themeHue
    if (hue) {
      document.documentElement.style.setProperty('--neutral-tint', hue)
    }
  }, [appSettings.themeHue])

  const [pluginSidebarItems, setPluginSidebarItems] = useState<Array<{ id: string; label: string; href: string }>>([])

  const refreshPluginState = useCallback(() => {
    api<Array<{ id: string; label: string; href: string }>>('GET', '/plugins/ui?type=sidebar').then(items => {
      if (Array.isArray(items)) setPluginSidebarItems(items)
    }).catch(() => {})
    void loadPlugins()
  }, [loadPlugins])

  useEffect(() => { refreshPluginState() }, [refreshPluginState])

  useWs('plugins', refreshPluginState)

  const [railExpanded, setRailExpanded] = useState(() => {
    const stored = safeStorageGet(RAIL_EXPANDED_KEY)
    return stored === null ? true : stored === 'true'
  })

  const toggleRail = () => {
    const next = !railExpanded
    setRailExpanded(next)
    safeStorageSet(RAIL_EXPANDED_KEY, String(next))
  }

  const handleSwitchUser = () => {
    setProfileSheetOpen(true)
  }

  const openNewSheet = () => {
    if (activeView === 'agents') setAgentSheetOpen(true)
    else if (activeView === 'schedules') setScheduleSheetOpen(true)
    else if (activeView === 'tasks') setTaskSheetOpen(true)
    else if (activeView === 'secrets') setSecretSheetOpen(true)
    else if (activeView === 'providers') setProviderSheetOpen(true)
    else if (activeView === 'skills') setSkillSheetOpen(true)
    else if (activeView === 'connectors') setConnectorSheetOpen(true)
    else if (activeView === 'chatrooms') useChatroomStore.getState().setChatroomSheetOpen(true)
    else if (activeView === 'webhooks') setWebhookSheetOpen(true)
    else if (activeView === 'mcp_servers') setMcpServerSheetOpen(true)
    else if (activeView === 'knowledge') setKnowledgeSheetOpen(true)
    else if (activeView === 'plugins') setPluginSheetOpen(true)
    else if (activeView === 'projects') setProjectSheetOpen(true)
  }

  const handleNavClick = (view: AppView) => {
    if (FULL_WIDTH_VIEWS.has(view)) {
      setActiveView(view)
      setSidebarOpen(false)
    } else if (activeView === view && sidebarOpen) {
      setSidebarOpen(false)
    } else {
      setActiveView(view)
      setSidebarOpen(true)
    }
  }

  const agents = useAppStore((s) => s.agents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const defaultAgentId = appSettings.defaultAgentId && agents[appSettings.defaultAgentId]
    ? appSettings.defaultAgentId
    : Object.values(agents)[0]?.id || null
  const isMainChat = activeView === 'agents' && currentAgentId === defaultAgentId

  const swipeHandlers = useSwipe({
    onSwipe: (dir) => {
      if (isDesktop) return
      if (dir === 'right') setSidebarOpen(true)
      else setSidebarOpen(false)
    },
    leftSwipeEnabled: !isDesktop && sidebarOpen,
  })

  const currentSession = currentSessionId ? sessions[currentSessionId] : null
  const hasCanvas = !!(currentSession?.canvasContent && canvasDismissedFor !== currentSessionId)
  const canvasAgentName = currentSession?.agentId && agents[currentSession.agentId] ? agents[currentSession.agentId].name : undefined

  const goToMainChat = async () => {
    if (defaultAgentId) {
      await setCurrentAgent(defaultAgentId)
    }
    setActiveView('agents')
    setSidebarOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
  }

  return (
    <div
      className="h-full flex overflow-hidden"
      onTouchStart={isDesktop ? undefined : swipeHandlers.onTouchStart}
      onTouchMove={isDesktop ? undefined : swipeHandlers.onTouchMove}
      onTouchEnd={isDesktop ? undefined : swipeHandlers.onTouchEnd}
    >
      {/* Desktop: Navigation rail (expandable) */}
      {isDesktop && (
        <div
          className="shrink-0 bg-raised border-r border-white/[0.04] flex flex-col py-4 min-h-0 transition-all duration-300 overflow-visible"
          style={{ width: railExpanded ? 180 : 60, transitionTimingFunction: 'var(--ease-spring)' }}
        >
          {/* Logo + collapse toggle */}
          <div className={`flex items-center mb-4 shrink-0 ${railExpanded ? 'px-4 gap-3' : 'justify-center'}`}>
            <div className="w-10 h-10 rounded-[11px] bg-gradient-to-br from-[#4338CA] to-[#6366F1] flex items-center justify-center shrink-0
              shadow-[0_2px_12px_rgba(99,102,241,0.2)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
                <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
              </svg>
            </div>
            {railExpanded && (
              <button
                onClick={toggleRail}
                className="ml-auto w-7 h-7 rounded-[8px] flex items-center justify-center text-text-3 hover:text-text hover:bg-white/[0.04] transition-all cursor-pointer bg-transparent border-none"
                title="Collapse sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="11 17 6 12 11 7" />
                  <polyline points="18 17 13 12 18 7" />
                </svg>
              </button>
            )}
          </div>

          {/* Expand button when collapsed */}
          {!railExpanded && (
            <div className="flex justify-center mb-2">
              <button
                onClick={toggleRail}
                className="rail-btn"
                title="Expand sidebar"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="13 17 18 12 13 7" />
                  <polyline points="6 17 11 12 6 7" />
                </svg>
              </button>
            </div>
          )}

          {/* Main Chat shortcut */}
          {railExpanded ? (
            <div className="px-3 mb-2">
              <button
                onClick={goToMainChat}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all
                  ${isMainChat
                    ? 'bg-accent-bright/15 border border-[#6366F1]/25 text-accent-bright'
                    : 'bg-accent-bright/10 border border-[#6366F1]/20 text-accent-bright hover:bg-accent-bright/15'}`}
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Main Chat
              </button>
            </div>
          ) : (
            <RailTooltip label="Main Chat" description="Your persistent assistant chat">
              <button
                onClick={goToMainChat}
                className={`rail-btn self-center mb-2 ${isMainChat ? 'active' : ''}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </RailTooltip>
          )}

          {/* Search */}
          {railExpanded ? (
            <div className="px-3 mb-2">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('swarmclaw:open-search'))}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                  bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Search
                <kbd className="ml-auto px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-text-3">
                  ⌘K
                </kbd>
              </button>
            </div>
          ) : (
            <RailTooltip label="Search" description="Search across all entities (⌘K)">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('swarmclaw:open-search'))}
                className="rail-btn self-center mb-2"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </RailTooltip>
          )}

          <div className="flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain touch-pan-y">
            {/* Nav items */}
            <div className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
            <NavItem view="home" label="Home" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('home')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </NavItem>
            <NavItem view="agents" label="Agents" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('agents')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
            </NavItem>
            {plugins['chatroom']?.enabled !== false && (
            <NavItem view="chatrooms" label="Chatrooms" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('chatrooms')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                <path d="M8 10h8" /><path d="M8 14h4" />
              </svg>
            </NavItem>
            )}
            <NavItem view="projects" label="Projects" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('projects')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" /><path d="M14 2v7h7" />
              </svg>
            </NavItem>
            {plugins['schedule']?.enabled !== false && (
            <NavItem view="schedules" label="Schedules" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('schedules')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            </NavItem>
            )}
            {plugins['memory']?.enabled !== false && (
            <NavItem view="memory" label="Memory" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('memory')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            </NavItem>
            )}
            <NavItem view="tasks" label="Tasks" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('tasks')} badge={pendingApprovalCount}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
              </svg>
            </NavItem>
            <NavItem view="approvals" label="Approvals" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('approvals')} badge={pendingApprovalCount}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                <path d="m9 12 2 2 4-4"/>
              </svg>
            </NavItem>
            <NavItem view="secrets" label="Secrets" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('secrets')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </NavItem>
            <NavItem view="providers" label="Providers" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('providers')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
              </svg>
            </NavItem>
            <NavItem view="skills" label="Skills" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('skills')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </NavItem>
            {plugins['connectors']?.enabled !== false && (
            <NavItem view="connectors" label="Connectors" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('connectors')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </NavItem>
            )}
            {plugins['http']?.enabled !== false && (
            <NavItem view="webhooks" label="Webhooks" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('webhooks')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M22 12h-4l-3 7L9 5l-3 7H2" />
              </svg>
            </NavItem>
            )}
            <NavItem view="mcp_servers" label="MCP" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('mcp_servers')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </NavItem>
            <NavItem view="knowledge" label="Knowledge" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('knowledge')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </NavItem>
            <NavItem view="plugins" label="Plugins" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('plugins')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="4" /><path d="M8 8L5.5 5.5M16 8l2.5-2.5M8 16l-2.5 2.5M16 16l2.5 2.5" />
              </svg>
            </NavItem>
            <NavItem view="usage" label="Usage" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('usage')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </NavItem>
            {plugins['wallet']?.enabled !== false && (
            <NavItem view="wallets" label="Wallets" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('wallets')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="14" rx="2" /><path d="M22 10H18a2 2 0 0 0 0 4h4" /><path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
              </svg>
            </NavItem>
            )}
            <NavItem view="runs" label="Runs" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('runs')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </NavItem>
            <NavItem view="activity" label="Activity" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('activity')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" />
              </svg>
            </NavItem>
            {plugins['monitor']?.enabled !== false && (
            <NavItem view="logs" label="Logs" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('logs')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
              </svg>
            </NavItem>
            )}
            </div>

            <div className="flex-1" />

            {/* Bottom: Docs + Daemon + Settings + User */}
            <div className={`flex flex-col gap-1 ${railExpanded ? 'px-3' : 'items-center'}`}>
            {railExpanded ? (
              <a
                href="https://swarmclaw.ai/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                  bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] no-underline"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
                Docs
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="ml-auto opacity-40">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            ) : (
              <RailTooltip label="Docs" description="Open documentation site">
                <a
                  href="https://swarmclaw.ai/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rail-btn"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                </a>
              </RailTooltip>
            )}
            {railExpanded ? (
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                  bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] no-underline"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                Star on GitHub
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="ml-auto opacity-40">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            ) : (
              <RailTooltip label="Star on GitHub" description="Support SwarmClaw with a GitHub star">
                <a
                  href={GITHUB_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rail-btn"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </a>
              </RailTooltip>
            )}
            {railExpanded && <DaemonIndicator />}
            {railExpanded ? (
              <NotificationCenter variant="row" align="left" direction="up" />
            ) : (
              <RailTooltip label="Notifications" description="View system notifications">
                <div className="rail-btn flex items-center justify-center">
                  <NotificationCenter align="left" direction="up" />
                </div>
              </RailTooltip>
            )}
            <NavItem view="settings" label="Settings" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('settings')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </NavItem>

            {railExpanded ? (
              <button
                onClick={handleSwitchUser}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] cursor-pointer transition-all
                  bg-transparent hover:bg-white/[0.04] border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
                <span className="text-[13px] font-500 text-text-2 capitalize truncate">{currentUser}</span>
              </button>
            ) : (
              <RailTooltip label="Profile" description="Edit your profile">
                <button onClick={handleSwitchUser} className="mt-2 bg-transparent border-none cursor-pointer shrink-0">
                  <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
                </button>
              </RailTooltip>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Desktop: Side panel (wallets has its own built-in sidebar) */}
      {isDesktop && sidebarOpen && activeView !== 'wallets' && activeView !== 'approvals' && (
        <div
          className="w-[280px] shrink-0 bg-raised border-r border-white/[0.04] flex flex-col h-full min-h-0 overflow-hidden touch-pan-y"
          style={{ animation: 'panel-in 0.3s var(--ease-spring)' }}
        >
          <div className="flex items-center px-5 pt-5 pb-3 shrink-0">
            <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">{activeView}</h2>
            {activeView === 'logs' || activeView === 'usage' || activeView === 'runs' ? null : activeView === 'memory' ? (
              <button
                onClick={() => useAppStore.getState().setMemorySheetOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Memory
              </button>
            ) : (
              <button
                onClick={openNewSheet}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {activeView === 'agents' ? 'Agent' : activeView === 'schedules' ? 'Schedule' : activeView === 'tasks' ? 'Task' : activeView === 'secrets' ? 'Secret' : activeView === 'providers' ? 'Provider' : activeView === 'skills' ? 'Skill' : activeView === 'connectors' ? 'Connector' : activeView === 'webhooks' ? 'Webhook' : activeView === 'mcp_servers' ? 'MCP Server' : activeView === 'knowledge' ? 'Knowledge' : 'New'}
              </button>
            )}
          </div>
          {activeView === 'agents' && (
            <>
              <div className="flex gap-1 px-4 pb-2">
                {(['chat', 'config'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setAgentViewMode(mode)}
                    className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
                      ${agentViewMode === mode ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              {agentViewMode === 'chat' ? <AgentChatList inSidebar /> : <AgentList inSidebar />}
            </>
          )}
          {activeView === 'schedules' && <ScheduleList inSidebar />}
          {activeView === 'memory' && <MemoryAgentList />}
          {activeView === 'tasks' && <TaskList inSidebar />}
          {activeView === 'secrets' && <SecretsList inSidebar />}
          {activeView === 'providers' && <ProviderList inSidebar />}
          {activeView === 'skills' && <SkillList inSidebar />}
          {activeView === 'connectors' && <ConnectorList inSidebar />}
          {activeView === 'webhooks' && <WebhookList inSidebar />}
          {activeView === 'mcp_servers' && <McpServerList />}
          {activeView === 'knowledge' && <KnowledgeList />}
          {activeView === 'runs' && <RunList />}
          {activeView === 'logs' && <LogList />}
        </div>
      )}

      {/* Mobile: Drawer */}
      {!isDesktop && sidebarOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div
            className="absolute inset-y-0 left-0 w-[300px] bg-raised shadow-[4px_0_60px_rgba(0,0,0,0.7)] flex flex-col min-h-0 overflow-hidden touch-pan-y"
            style={{ animation: 'slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
          >
            <div className="flex items-center gap-3 px-5 py-4 shrink-0">
              <div className="w-9 h-9 rounded-[10px] bg-gradient-to-br from-[#4338CA] to-[#6366F1] flex items-center justify-center
                shadow-[0_2px_8px_rgba(99,102,241,0.15)]">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white">
                  <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
                </svg>
              </div>
              <span className="font-display text-[15px] font-600 flex-1 tracking-[-0.02em]">SwarmClaw</span>
              <a href="https://swarmclaw.ai/docs" target="_blank" rel="noopener noreferrer" className="rail-btn" title="Documentation">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
              </a>
              <button onClick={() => handleNavClick('settings')} className={`rail-btn ${activeView === 'settings' ? 'active' : ''}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button onClick={handleSwitchUser} className="bg-transparent border-none cursor-pointer shrink-0">
                <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
              </button>
            </div>
            {/* View selector tabs */}
            <div className="flex px-4 py-2 gap-1 shrink-0 flex-wrap">
              {(['agents', 'chatrooms', 'schedules', 'memory', 'tasks', 'secrets', 'providers', 'skills', 'connectors', 'webhooks', 'mcp_servers', 'knowledge', 'plugins', 'usage', 'runs', 'logs'] as AppView[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setActiveView(v)}
                  className={`py-2 px-2.5 rounded-[10px] text-[11px] font-600 capitalize cursor-pointer transition-all
                    ${activeView === v
                      ? 'bg-accent-soft text-accent-bright'
                      : 'bg-transparent text-text-3 hover:text-text-2'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {v}
                </button>
              ))}
              {/* Dynamic Plugin Items */}
              {pluginSidebarItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => window.open(item.href, '_blank')}
                  className="py-2 px-2.5 rounded-[10px] text-[11px] font-600 capitalize cursor-pointer transition-all bg-emerald-500/[0.05] text-emerald-400/80 hover:text-emerald-400 border border-emerald-400/10"
                  style={{ fontFamily: 'inherit' }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {activeView !== 'logs' && activeView !== 'usage' && activeView !== 'runs' && activeView !== 'settings' && (
            <div className="px-4 py-2.5 shrink-0">
              <button
                onClick={() => {
                  setSidebarOpen(false)
                  openNewSheet()
                }}
                className="w-full py-3 rounded-[12px] border-none bg-accent-bright text-white text-[14px] font-600 cursor-pointer
                  hover:brightness-110 active:scale-[0.98] transition-all
                  shadow-[0_2px_12px_rgba(99,102,241,0.15)]"
                style={{ fontFamily: 'inherit' }}
              >
                + New {activeView === 'agents' ? 'Agent' : activeView === 'schedules' ? 'Schedule' : activeView === 'tasks' ? 'Task' : activeView === 'secrets' ? 'Secret' : activeView === 'providers' ? 'Provider' : activeView === 'skills' ? 'Skill' : activeView === 'connectors' ? 'Connector' : activeView === 'webhooks' ? 'Webhook' : activeView === 'mcp_servers' ? 'MCP Server' : activeView === 'knowledge' ? 'Knowledge' : activeView === 'plugins' ? 'Plugin' : activeView === 'projects' ? 'Project' : 'Entry'}
              </button>
            </div>
            )}
            {activeView === 'agents' && (
              <>
                <div className="flex gap-1 px-4 pb-2">
                  {(['chat', 'config'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setAgentViewMode(mode)}
                      className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 capitalize cursor-pointer transition-all
                        ${agentViewMode === mode ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                {agentViewMode === 'chat' ? <AgentChatList inSidebar onSelect={() => setSidebarOpen(false)} /> : <AgentList inSidebar />}
              </>
            )}
            {activeView === 'schedules' && <ScheduleList inSidebar />}
            {activeView === 'memory' && <MemoryAgentList />}
            {activeView === 'tasks' && <TaskList inSidebar />}
            {activeView === 'secrets' && <SecretsList inSidebar />}
            {activeView === 'providers' && <ProviderList inSidebar />}
            {activeView === 'skills' && <SkillList inSidebar />}
            {activeView === 'connectors' && <ConnectorList inSidebar />}
            {activeView === 'webhooks' && <WebhookList inSidebar />}
            {activeView === 'mcp_servers' && <McpServerList />}
            {activeView === 'knowledge' && <KnowledgeList />}
            {activeView === 'plugins' && <PluginList inSidebar />}
            {activeView === 'runs' && <RunList />}
            {activeView === 'logs' && <LogList />}
          </div>
        </div>
      )}

      {/* Main content */}
      <ErrorBoundary>
        <div className="flex-1 flex flex-col h-full min-h-0 min-w-0 bg-bg">
          {!isDesktop && <MobileHeader />}
          {activeView === 'home' ? (
            <HomeView />
          ) : activeView === 'agents' && hasSelectedSession ? (
            <div className="flex-1 flex h-full min-h-0 min-w-0">
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <ChatArea />
              </div>
              {hasCanvas && currentSessionId && (
                <CanvasPanel
                  sessionId={currentSessionId}
                  agentName={canvasAgentName}
                  onClose={() => setCanvasDismissedFor(currentSessionId)}
                />
              )}
            </div>
          ) : activeView === 'agents' ? (
            <div className="flex-1 flex flex-col">
              {!isDesktop ? (
                <AgentChatList />
              ) : (
                <div className="flex-1 flex items-center justify-center px-8">
                  <div className="text-center max-w-[420px]">
                    <h2 className="font-display text-[24px] font-700 text-text mb-2 tracking-[-0.02em]">
                      Select an Agent
                    </h2>
                    <p className="text-[14px] text-text-3">
                      Choose an agent from the sidebar to start chatting.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : activeView === 'tasks' && isDesktop ? (
            <TaskBoard />
          ) : activeView === 'approvals' ? (
            <ApprovalsPanel />
          ) : activeView === 'memory' ? (
            <MemoryBrowser />
          ) : activeView === 'activity' ? (
            <ActivityFeed />
          ) : activeView === 'usage' ? (
            <MetricsDashboard />
          ) : activeView === 'wallets' ? (
            <WalletPanel />
          ) : activeView === 'chatrooms' ? (
            <div className="flex-1 flex h-full min-w-0">
              <div className="w-[280px] shrink-0 border-r border-white/[0.06] flex flex-col">
                <div className="flex items-center px-4 pt-4 pb-2 shrink-0">
                  <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">Chatrooms</h2>
                  <button
                    onClick={() => { useChatroomStore.getState().setEditingChatroomId(null); useChatroomStore.getState().setChatroomSheetOpen(true) }}
                    className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New
                  </button>
                </div>
                <ChatroomList />
              </div>
              <ChatroomView />
            </div>
          ) : activeView === 'projects' ? (
            <div className="flex-1 flex h-full min-w-0">
              <div className="w-[280px] shrink-0 border-r border-white/[0.06] flex flex-col">
                <ProjectList />
              </div>
              <ProjectDetail />
            </div>
          ) : activeView === 'settings' ? (
            <SettingsPage />
          ) : !sidebarOpen && FULL_WIDTH_VIEWS.has(activeView) ? (
            <div className="flex-1 flex flex-col h-full">
              <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
                <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">
                  {activeView === 'mcp_servers' ? 'MCP Servers' : activeView.replace('_', ' ')}
                </h2>
                {activeView !== 'runs' && activeView !== 'logs' && (
                  <button
                    onClick={openNewSheet}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    {activeView === 'schedules' ? 'Schedule' : activeView === 'secrets' ? 'Secret' : activeView === 'providers' ? 'Provider' : activeView === 'skills' ? 'Skill' : activeView === 'connectors' ? 'Connector' : activeView === 'webhooks' ? 'Webhook' : activeView === 'mcp_servers' ? 'MCP Server' : activeView === 'knowledge' ? 'Knowledge' : activeView === 'plugins' ? 'Plugin' : 'New'}
                  </button>
                )}
              </div>
              {activeView === 'schedules' && <ScheduleList />}
              {activeView === 'secrets' && <SecretsList />}
              {activeView === 'providers' && <ProviderList />}
              {activeView === 'skills' && <SkillList />}
              {activeView === 'connectors' && <ConnectorList />}
              {activeView === 'webhooks' && <WebhookList />}
              {activeView === 'mcp_servers' && <McpServerList />}
              {activeView === 'knowledge' && <KnowledgeList />}
              {activeView === 'plugins' && <PluginList />}
              {activeView === 'runs' && <RunList />}
              {activeView === 'logs' && <LogList />}
            </div>
          ) : (
            <ViewEmptyState view={activeView} />
          )}
        </div>
      </ErrorBoundary>

      <CommandPalette />
      <SearchDialog />
      <AgentSwitchDialog />
      <KeyboardShortcutsDialog />
      <AgentSheet />
      <ScheduleSheet />
      <MemorySheet />
      <TaskSheet />
      <SecretSheet />
      <ProviderSheet />
      <SkillSheet />
      <ConnectorSheet />
      <ChatroomSheet />
      <WebhookSheet />
      <McpServerSheet />
      <KnowledgeSheet />
      <PluginSheet />
      <ProjectSheet />
      <ProfileSheet open={profileSheetOpen} onClose={() => setProfileSheetOpen(false)} />

    </div>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-8 bg-bg">
          <div className="text-center max-w-[400px]">
            <div className="w-14 h-14 rounded-[16px] bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-red-400">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="font-display text-[22px] font-700 text-text mb-2 tracking-[-0.02em]">
              Something went wrong
            </h2>
            <p className="text-[14px] text-text-3 mb-6">
              An unexpected error occurred. Try reloading the page.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-[12px] border-none bg-accent-bright text-white text-[14px] font-600 cursor-pointer
                hover:brightness-110 active:scale-[0.97] transition-all shadow-[0_4px_16px_rgba(99,102,241,0.2)]"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

const VIEW_DESCRIPTIONS: Record<AppView, string> = {
  home: 'Dashboard overview',
  agents: 'Chat with & configure your AI agents',
  chatrooms: 'Multi-agent collaborative chatrooms',
  schedules: 'Automated task schedules',
  memory: 'Long-term agent memory store',
  tasks: 'Task board for orchestrator jobs',
  approvals: 'Pending tool execution approvals',
  secrets: 'API keys & credentials for orchestrators',
  providers: 'LLM providers & custom endpoints',
  skills: 'Reusable instruction sets for agents',
  connectors: 'Chat platform bridges (Discord, Slack, etc.)',
  webhooks: 'Inbound HTTP triggers for event-driven workflows',
  mcp_servers: 'Connect agents to external MCP tool servers',
  knowledge: 'Shared knowledge base accessible by all agents',
  logs: 'Application logs & error tracking',
  plugins: 'Extend agent capabilities with custom plugins',
  usage: 'Usage metrics, cost tracking & agent performance',
  wallets: 'Agent crypto wallets — hold funds, send SOL, manage spending',
  runs: 'Live run monitoring & history',
  settings: 'Manage providers, API keys & orchestrator engine',
  projects: 'Group agents, tasks & schedules into projects',
  activity: 'Audit trail of all entity mutations',
}

const FULL_WIDTH_VIEWS = new Set<AppView>([
  'home', 'chatrooms', 'schedules', 'secrets', 'providers', 'skills',
  'connectors', 'webhooks', 'mcp_servers', 'knowledge', 'plugins',
  'usage', 'wallets', 'runs', 'logs', 'settings', 'activity', 'projects',
])

const VIEW_EMPTY_STATES: Record<Exclude<AppView, 'agents' | 'home'>, { icon: string; title: string; description: string; features: string[] }> = {
  chatrooms: {
    icon: 'message-square',
    title: 'Chatrooms',
    description: 'Multi-agent chatrooms for collaborative conversations. Add agents and use @mentions to trigger responses.',
    features: ['Create chatrooms with multiple AI agents', 'Use @AgentName to trigger specific agents', '@all mentions trigger all agents sequentially', 'Agents can chain by mentioning each other'],
  },
  schedules: {
    icon: 'clock',
    title: 'Schedules',
    description: 'Automate recurring tasks by scheduling orchestrators to run on a cron, interval, or one-time basis.',
    features: ['Set up cron expressions for precise timing', 'Run orchestrators automatically on intervals', 'Schedule one-time future tasks', 'View execution history and results'],
  },
  memory: {
    icon: 'database',
    title: 'Memory',
    description: 'Long-term memory store for AI agents. Orchestrators can store and retrieve knowledge across conversations.',
    features: ['Agents store findings and learnings automatically', 'Full-text search across all stored memories', 'Organized by categories and agents', 'Persists across conversations for continuity'],
  },
  tasks: {
    icon: 'clipboard',
    title: 'Task Board',
    description: 'A Trello-style board for managing orchestrator jobs. Create tasks, assign them to orchestrators, and track progress.',
    features: ['Kanban columns: Backlog, Queued, Running, Completed, Failed', 'Assign tasks to specific orchestrator agents', 'Sequential queue ensures orchestrators don\'t conflict', 'View results and logs for completed tasks'],
  },
  secrets: {
    icon: 'lock',
    title: 'Secrets',
    description: 'Manage API keys and credentials that orchestrators can access during task execution.',
    features: ['Store keys for external services (Gmail, APIs, etc.)', 'Scope secrets globally or to specific orchestrators', 'Encrypted at rest with AES-256-GCM', 'Orchestrators retrieve secrets via the get_secret tool'],
  },
  providers: {
    icon: 'zap',
    title: 'Providers',
    description: 'Manage LLM providers including built-in and custom OpenAI-compatible endpoints.',
    features: ['Built-in support for Claude, OpenAI, Anthropic, and Ollama', 'Add custom OpenAI-compatible providers (OpenRouter, Together, Groq)', 'Configure base URLs, models, and API keys per provider', 'Custom providers work seamlessly with all features'],
  },
  skills: {
    icon: 'book',
    title: 'Skills',
    description: 'Upload and manage reusable instruction sets that agents can use during task execution.',
    features: ['Upload markdown files with specialized instructions', 'Assign skills to specific agents', 'Skills are injected into agent system prompts', 'Create libraries of reusable expertise'],
  },
  connectors: {
    icon: 'link',
    title: 'Connectors',
    description: 'Bridge chat platforms to your AI agents. Receive messages from Discord, Telegram, Slack, or WhatsApp and route them to agents.',
    features: ['Connect Discord, Telegram, Slack, or WhatsApp bots', 'Route incoming messages to any agent', 'Each platform channel gets its own chat thread', 'Start and stop connectors from the UI'],
  },
  webhooks: {
    icon: 'webhook',
    title: 'Webhooks',
    description: 'Receive external events over HTTP and trigger orchestrator runs automatically.',
    features: ['Create secure inbound webhook endpoints', 'Filter events by type or source', 'Route each webhook to a specific orchestrator', 'Use x-webhook-secret for request authentication'],
  },
  mcp_servers: {
    icon: 'server',
    title: 'MCP Servers',
    description: 'Connect agents to external MCP (Model Context Protocol) servers, injecting their tools into agent chats.',
    features: ['Configure stdio, SSE, or streamable HTTP transports', 'Test connections and discover available tools', 'Assign MCP servers to specific agents', 'Tools appear alongside built-in tools in chat'],
  },
  knowledge: {
    icon: 'globe',
    title: 'Knowledge Base',
    description: 'A shared knowledge graph accessible by all agents, enabling cross-agent information sharing and orchestration.',
    features: ['Create tagged knowledge entries', 'Agents can store and search knowledge via tools', 'Full-text and vector search', 'Provenance tracking per entry'],
  },
  logs: {
    icon: 'file-text',
    title: 'Logs',
    description: 'View application logs, errors, and debug information. Logs auto-refresh in real-time.',
    features: ['Filter by level: ERROR, WARN, INFO, DEBUG', 'Search through log entries', 'Auto-refresh with live mode', 'Click entries to expand details'],
  },
  plugins: {
    icon: 'puzzle',
    title: 'Plugins',
    description: 'Extend agent behavior with hooks. Install from the marketplace, a URL, or drop .js files into data/plugins/.',
    features: ['Install plugins from the marketplace or a URL', 'Toggle plugins on/off', 'Lifecycle hooks: beforeChat, afterChat, onError', 'Compatible with OpenClaw plugin format'],
  },
  usage: {
    icon: 'bar-chart',
    title: 'Usage',
    description: 'Track token usage and costs across all providers and agents.',
    features: ['Per-provider cost breakdown', 'Token usage over time', 'Per-agent cost tracking', 'Export usage data'],
  },
  runs: {
    icon: 'activity',
    title: 'Runs',
    description: 'View the run queue and execution history.',
    features: ['Monitor queued and running tasks', 'View run results and errors', 'Cancel pending runs', 'Automatic retry tracking'],
  },
  settings: {
    icon: 'settings',
    title: 'Settings',
    description: 'Manage providers, API keys & orchestrator engine.',
    features: ['Configure LLM providers', 'Manage API credentials', 'Tune orchestrator settings', 'Set up voice & embedding'],
  },
  projects: {
    icon: 'folder',
    title: 'Projects',
    description: 'Organize your work into projects. Group agents, tasks, and schedules under a common scope.',
    features: ['Create named projects with color badges', 'Assign agents and tasks to projects', 'Filter sidebar views by project', 'Global view when no filter is active'],
  },
  activity: {
    icon: 'clock',
    title: 'Activity',
    description: 'Audit trail of all entity mutations across the system.',
    features: ['Track agent, task, and connector changes', 'Filter by entity type and action', 'Real-time updates via WebSocket', 'Relative timestamps'],
  },
  wallets: {
    icon: 'wallet',
    title: 'Wallets',
    description: 'Agent crypto wallets for autonomous financial operations on Solana.',
    features: ['Create Solana wallets for agents', 'Per-transaction and daily spending limits', 'User approval for transactions', 'Balance tracking and transaction history'],
  },
  approvals: {
    icon: 'check-circle',
    title: 'Approvals',
    description: 'Review and approve pending tool executions from agents.',
    features: ['Review tool calls before execution', 'Approve or reject agent actions', 'Full context for each pending approval'],
  },
}

function ViewEmptyState({ view }: { view: AppView }) {
  if (view === 'agents' || view === 'home') return null
  const config = VIEW_EMPTY_STATES[view as Exclude<AppView, 'agents' | 'home'>]
  if (!config) return null

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 pb-20 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.03) 0%, transparent 70%)',
            animation: 'glow-pulse 8s ease-in-out infinite',
          }} />
      </div>

      <div className="relative max-w-[520px] w-full text-center"
        style={{ animation: 'fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 rounded-[16px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
            <ViewEmptyIcon type={config.icon} />
          </div>
        </div>

        <h2 className="font-display text-[28px] font-800 leading-[1.15] tracking-[-0.03em] mb-3 text-text">
          {config.title}
        </h2>
        <p className="text-[14px] text-text-3 leading-[1.6] mb-8 max-w-[400px] mx-auto">
          {config.description}
        </p>

        <div className="text-left max-w-[380px] mx-auto space-y-3">
          {config.features.map((feature) => (
            <div key={feature} className="flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-accent-bright shrink-0 mt-0.5">
                <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
              </svg>
              <span className="text-[13px] text-text-2/70 leading-[1.5]">{feature}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ViewEmptyIcon({ type }: { type: string }) {
  const cls = "text-text-3"
  switch (type) {
    case 'user':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
    case 'clock':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
    case 'database':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>
    case 'clipboard':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" /></svg>
    case 'lock':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
    case 'zap':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></svg>
    case 'book':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
    case 'link':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
    case 'webhook':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M22 12h-4l-3 7L9 5l-3 7H2" /></svg>
    case 'server':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>
    case 'globe':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
    case 'file-text':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
    case 'puzzle':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="4" /><path d="M8 8L5.5 5.5M16 8l2.5-2.5M8 16l-2.5 2.5M16 16l2.5 2.5" /></svg>
    case 'bar-chart':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
    case 'activity':
      return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={cls}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
    default:
      return null
  }
}

function NavItem({ view, label, expanded, active, sidebarOpen, onClick, badge, children }: {
  view: AppView
  label: string
  expanded: boolean
  active: AppView
  sidebarOpen: boolean
  onClick: () => void
  badge?: number
  children: React.ReactNode
}) {
  const isActive = active === view && (sidebarOpen || FULL_WIDTH_VIEWS.has(view))

  if (expanded) {
    return (
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all border-none
          ${isActive
            ? 'bg-accent-soft text-accent-bright'
            : 'bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04]'}`}
        style={{ fontFamily: 'inherit' }}
      >
        <span className="shrink-0 relative">
          {children}
          {!!badge && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-0.5">
              {badge}
            </span>
          )}
        </span>
        <span className="truncate" style={{ animation: 'spring-in 0.4s var(--ease-spring)' }}>{label}</span>
      </button>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} className={`rail-btn ${isActive ? 'active' : ''} relative`}>
          {children}
          {!!badge && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-0.5">
              {badge}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[10px] px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-text-3 leading-[1.4]">{VIEW_DESCRIPTIONS[view]}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function RailTooltip({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[10px] px-3.5 py-2.5 max-w-[200px]">
        <div className="font-display text-[13px] font-600 mb-0.5">{label}</div>
        <div className="text-[11px] text-text-3 leading-[1.4]">{description}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function DesktopEmptyState({ userName }: { userName: string | null }) {
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen)

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 pb-20 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.04) 0%, transparent 70%)',
            animation: 'glow-pulse 8s ease-in-out infinite',
          }} />
      </div>

      <div className="relative max-w-[560px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}>
        <div className="flex justify-center mb-8">
          <div className="relative">
            <svg width="40" height="40" viewBox="0 0 48 48" fill="none" className="text-accent-bright"
              style={{ animation: 'sparkle-spin 10s linear infinite' }}>
              <path d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
                fill="currentColor" opacity="0.8" />
            </svg>
            <div className="absolute inset-0 blur-xl bg-accent-bright/15" />
          </div>
        </div>

        <h1 className="font-display text-[44px] font-800 leading-[1.1] tracking-[-0.04em] mb-5">
          Hi, <span className="text-accent-bright">{userName ? userName.charAt(0).toUpperCase() + userName.slice(1) : 'there'}</span>
          <br />
          <span className="text-text-2">What would you like to do?</span>
        </h1>
        <p className="text-[15px] text-text-3 mb-12">
          Create a new chat to start chatting
        </p>
        <button
          onClick={() => setNewSessionOpen(true)}
          className="inline-flex items-center gap-2.5 px-12 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
            cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
            shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Chat
        </button>
      </div>
    </div>
  )
}
