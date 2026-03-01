'use client'

import { Component, useState, useEffect, useCallback } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '@/stores/use-app-store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Avatar } from '@/components/shared/avatar'
import { SettingsSheet } from '@/components/shared/settings-sheet'
import { AgentList } from '@/components/agents/agent-list'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { AgentSheet } from '@/components/agents/agent-sheet'
import { ScheduleList } from '@/components/schedules/schedule-list'
import { ScheduleSheet } from '@/components/schedules/schedule-sheet'
import { MemoryList } from '@/components/memory/memory-list'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { MemoryDetail } from '@/components/memory/memory-detail'
import { TaskList } from '@/components/tasks/task-list'
import { TaskSheet } from '@/components/tasks/task-sheet'
import { TaskBoard } from '@/components/tasks/task-board'
import { SecretsList } from '@/components/secrets/secrets-list'
import { SecretSheet } from '@/components/secrets/secret-sheet'
import { ProviderList } from '@/components/providers/provider-list'
import { ProviderSheet } from '@/components/providers/provider-sheet'
import { SkillList } from '@/components/skills/skill-list'
import { SkillSheet } from '@/components/skills/skill-sheet'
import { ConnectorList } from '@/components/connectors/connector-list'
import { ConnectorSheet } from '@/components/connectors/connector-sheet'
import { WebhookList } from '@/components/webhooks/webhook-list'
import { WebhookSheet } from '@/components/webhooks/webhook-sheet'
import { LogList } from '@/components/logs/log-list'
import { McpServerList } from '@/components/mcp-servers/mcp-server-list'
import { McpServerSheet } from '@/components/mcp-servers/mcp-server-sheet'
import { KnowledgeList } from '@/components/knowledge/knowledge-list'
import { KnowledgeSheet } from '@/components/knowledge/knowledge-sheet'
import { PluginList } from '@/components/plugins/plugin-list'
import { PluginSheet } from '@/components/plugins/plugin-sheet'
import { UsageList } from '@/components/usage/usage-list'
import { RunList } from '@/components/runs/run-list'
import { NetworkBanner } from './network-banner'
import { UpdateBanner } from './update-banner'
import { MobileHeader } from './mobile-header'
import { DaemonIndicator } from './daemon-indicator'
import { ChatArea } from '@/components/chat/chat-area'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import type { AppView } from '@/types'

const RAIL_EXPANDED_KEY = 'sc_rail_expanded'

export function AppLayout() {
  const currentUser = useAppStore((s) => s.currentUser)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setUser = useAppStore((s) => s.setUser)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
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
  const tasks = useAppStore((s) => s.tasks)
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const hasSelectedSession = !!(currentSessionId && sessions[currentSessionId])
  const pendingApprovalCount = Object.values(tasks).filter((t) => t.pendingApproval).length

  const [agentViewMode, setAgentViewMode] = useState<'chat' | 'config'>('chat')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const handleShortcutKey = useCallback((e: KeyboardEvent) => {
    // Ctrl+/ or Cmd+/
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault()
      setShortcutsOpen((v) => !v)
      return
    }
    // ? key when not in an input/textarea/contenteditable
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const editable = (e.target as HTMLElement)?.isContentEditable
      if (tag === 'input' || tag === 'textarea' || editable) return
      e.preventDefault()
      setShortcutsOpen((v) => !v)
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [handleShortcutKey])

  const [railExpanded, setRailExpanded] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(RAIL_EXPANDED_KEY)
    return stored === null ? true : stored === 'true'
  })

  const toggleRail = () => {
    const next = !railExpanded
    setRailExpanded(next)
    localStorage.setItem(RAIL_EXPANDED_KEY, String(next))
  }

  const handleSwitchUser = () => {
    setUser(null)
    setCurrentSession(null)
  }

  const openNewSheet = () => {
    if (activeView === 'agents') setAgentSheetOpen(true)
    else if (activeView === 'schedules') setScheduleSheetOpen(true)
    else if (activeView === 'tasks') setTaskSheetOpen(true)
    else if (activeView === 'secrets') setSecretSheetOpen(true)
    else if (activeView === 'providers') setProviderSheetOpen(true)
    else if (activeView === 'skills') setSkillSheetOpen(true)
    else if (activeView === 'connectors') setConnectorSheetOpen(true)
    else if (activeView === 'webhooks') setWebhookSheetOpen(true)
    else if (activeView === 'mcp_servers') setMcpServerSheetOpen(true)
    else if (activeView === 'knowledge') setKnowledgeSheetOpen(true)
    else if (activeView === 'plugins') setPluginSheetOpen(true)
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
  const mainSession = Object.values(sessions).find((s) => s.name === '__main__' && s.user === currentUser)

  const goToMainChat = async () => {
    // Navigate to default agent's chat thread
    const defaultAgent = agents['default'] || Object.values(agents)[0]
    if (defaultAgent) {
      await setCurrentAgent(defaultAgent.id)
    } else if (mainSession) {
      setCurrentSession(mainSession.id)
    }
    setActiveView('agents')
    setSidebarOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* Desktop: Navigation rail (expandable) */}
      {isDesktop && (
        <div
          className="shrink-0 bg-raised border-r border-white/[0.04] flex flex-col py-4 transition-all duration-200 overflow-hidden"
          style={{ width: railExpanded ? 180 : 60 }}
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
                  ${activeView === 'agents' && currentAgentId && (currentAgentId === 'default' || currentAgentId === Object.keys(agents)[0])
                    ? 'bg-[#6366F1]/15 border border-[#6366F1]/25 text-accent-bright'
                    : 'bg-[#6366F1]/10 border border-[#6366F1]/20 text-accent-bright hover:bg-[#6366F1]/15'}`}
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
                className={`rail-btn self-center mb-2 ${activeView === 'agents' && currentAgentId && (currentAgentId === 'default' || currentAgentId === Object.keys(agents)[0]) ? 'active' : ''}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </RailTooltip>
          )}

          {/* Nav items */}
          <div className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
            <NavItem view="agents" label="Agents" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('agents')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
            </NavItem>
            <NavItem view="schedules" label="Schedules" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('schedules')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            </NavItem>
            <NavItem view="memory" label="Memory" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('memory')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            </NavItem>
            <NavItem view="tasks" label="Tasks" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('tasks')} badge={pendingApprovalCount}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
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
            <NavItem view="connectors" label="Connectors" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('connectors')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </NavItem>
            <NavItem view="webhooks" label="Webhooks" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('webhooks')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M22 12h-4l-3 7L9 5l-3 7H2" />
              </svg>
            </NavItem>
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
            <NavItem view="runs" label="Runs" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('runs')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </NavItem>
            <NavItem view="logs" label="Logs" expanded={railExpanded} active={activeView} sidebarOpen={sidebarOpen} onClick={() => handleNavClick('logs')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
              </svg>
            </NavItem>
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
            {railExpanded && <DaemonIndicator />}
            {railExpanded ? (
              <button
                onClick={() => setSettingsOpen(true)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all
                  bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04] border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                Settings
              </button>
            ) : (
              <RailTooltip label="Settings" description="API keys, providers & app config">
                <button onClick={() => setSettingsOpen(true)} className="rail-btn">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </RailTooltip>
            )}

            {railExpanded ? (
              <button
                onClick={handleSwitchUser}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] cursor-pointer transition-all
                  bg-transparent hover:bg-white/[0.04] border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <Avatar user={currentUser!} size="sm" />
                <span className="text-[13px] font-500 text-text-2 capitalize truncate">{currentUser}</span>
              </button>
            ) : (
              <RailTooltip label="Switch User" description="Sign in as a different user">
                <button onClick={handleSwitchUser} className="mt-2 bg-transparent border-none cursor-pointer shrink-0">
                  <Avatar user={currentUser!} size="sm" />
                </button>
              </RailTooltip>
            )}
          </div>
        </div>
      )}

      {/* Desktop: Side panel */}
      {isDesktop && sidebarOpen && (
        <div
          className="w-[280px] shrink-0 bg-raised border-r border-white/[0.04] flex flex-col h-full"
          style={{ animation: 'panel-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          <div className="flex items-center px-5 pt-5 pb-3 shrink-0">
            <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">{activeView}</h2>
            {activeView === 'logs' || activeView === 'usage' || activeView === 'runs' ? null : activeView === 'memory' ? (
              <button
                onClick={() => useAppStore.getState().setMemorySheetOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-[#6366F1]/15 transition-all cursor-pointer"
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
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-[#6366F1]/15 transition-all cursor-pointer"
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
          {activeView === 'memory' && <MemoryList inSidebar />}
          {activeView === 'tasks' && <TaskList inSidebar />}
          {activeView === 'secrets' && <SecretsList inSidebar />}
          {activeView === 'providers' && <ProviderList inSidebar />}
          {activeView === 'skills' && <SkillList inSidebar />}
          {activeView === 'connectors' && <ConnectorList inSidebar />}
          {activeView === 'webhooks' && <WebhookList inSidebar />}
          {activeView === 'mcp_servers' && <McpServerList />}
          {activeView === 'knowledge' && <KnowledgeList />}
          {activeView === 'usage' && <UsageList />}
          {activeView === 'runs' && <RunList />}
          {activeView === 'logs' && <LogList />}
        </div>
      )}

      {/* Mobile: Drawer */}
      {!isDesktop && sidebarOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div
            className="absolute inset-y-0 left-0 w-[300px] bg-raised shadow-[4px_0_60px_rgba(0,0,0,0.7)] flex flex-col"
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
              <button onClick={() => setSettingsOpen(true)} className="rail-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button onClick={handleSwitchUser} className="bg-transparent border-none cursor-pointer shrink-0">
                <Avatar user={currentUser!} size="sm" />
              </button>
            </div>
            {/* View selector tabs */}
            <div className="flex px-4 py-2 gap-1 shrink-0 flex-wrap">
              {(['agents', 'schedules', 'memory', 'tasks', 'secrets', 'providers', 'skills', 'connectors', 'webhooks', 'mcp_servers', 'knowledge', 'plugins', 'usage', 'runs', 'logs'] as AppView[]).map((v) => (
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
            </div>
            {activeView !== 'logs' && activeView !== 'usage' && activeView !== 'runs' && (
            <div className="px-4 py-2.5 shrink-0">
              <button
                onClick={() => {
                  setSidebarOpen(false)
                  openNewSheet()
                }}
                className="w-full py-3 rounded-[12px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer
                  hover:brightness-110 active:scale-[0.98] transition-all
                  shadow-[0_2px_12px_rgba(99,102,241,0.15)]"
                style={{ fontFamily: 'inherit' }}
              >
                + New {activeView === 'agents' ? 'Agent' : activeView === 'schedules' ? 'Schedule' : activeView === 'tasks' ? 'Task' : activeView === 'secrets' ? 'Secret' : activeView === 'providers' ? 'Provider' : activeView === 'skills' ? 'Skill' : activeView === 'connectors' ? 'Connector' : activeView === 'webhooks' ? 'Webhook' : activeView === 'mcp_servers' ? 'MCP Server' : activeView === 'knowledge' ? 'Knowledge' : activeView === 'plugins' ? 'Plugin' : 'Entry'}
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
            {activeView === 'memory' && <MemoryList inSidebar onSelect={() => setSidebarOpen(false)} />}
            {activeView === 'tasks' && <TaskList inSidebar />}
            {activeView === 'secrets' && <SecretsList inSidebar />}
            {activeView === 'providers' && <ProviderList inSidebar />}
            {activeView === 'skills' && <SkillList inSidebar />}
            {activeView === 'connectors' && <ConnectorList inSidebar />}
            {activeView === 'webhooks' && <WebhookList inSidebar />}
            {activeView === 'mcp_servers' && <McpServerList />}
            {activeView === 'knowledge' && <KnowledgeList />}
            {activeView === 'plugins' && <PluginList inSidebar />}
            {activeView === 'usage' && <UsageList />}
            {activeView === 'runs' && <RunList />}
            {activeView === 'logs' && <LogList />}
          </div>
        </div>
      )}

      {/* Main content */}
      <ErrorBoundary>
        <div className="flex-1 flex flex-col h-full min-w-0 bg-bg">
          {!isDesktop && <MobileHeader />}
          {activeView === 'agents' && hasSelectedSession ? (
            <ChatArea />
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
          ) : activeView === 'memory' ? (
            <MemoryDetail />
          ) : !sidebarOpen && FULL_WIDTH_VIEWS.has(activeView) ? (
            <div className="flex-1 flex flex-col h-full">
              <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
                <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">
                  {activeView === 'mcp_servers' ? 'MCP Servers' : activeView.replace('_', ' ')}
                </h2>
                {activeView !== 'usage' && activeView !== 'runs' && activeView !== 'logs' && (
                  <button
                    onClick={openNewSheet}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-[#6366F1]/15 transition-all cursor-pointer"
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
              {activeView === 'usage' && <UsageList />}
              {activeView === 'runs' && <RunList />}
              {activeView === 'logs' && <LogList />}
            </div>
          ) : (
            <ViewEmptyState view={activeView} />
          )}
        </div>
      </ErrorBoundary>

      <SettingsSheet />
      <AgentSheet />
      <ScheduleSheet />
      <MemorySheet />
      <TaskSheet />
      <SecretSheet />
      <ProviderSheet />
      <SkillSheet />
      <ConnectorSheet />
      <WebhookSheet />
      <McpServerSheet />
      <KnowledgeSheet />
      <PluginSheet />

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-[380px] bg-raised border-white/[0.08]">
          <DialogHeader>
            <DialogTitle className="text-text">Keyboard Shortcuts</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {([
              ['Enter', 'Send message'],
              ['Shift + Enter', 'New line'],
              ['Ctrl + F', 'Search in chat'],
              ['Ctrl + /', 'Show shortcuts'],
            ] as const).map(([keys, desc]) => (
              <div key={keys} className="flex items-center justify-between">
                <span className="text-[13px] text-text-2">{desc}</span>
                <kbd className="px-2 py-1 rounded-[6px] bg-white/[0.06] border border-white/[0.08] text-[11px] font-mono text-text-3">{keys}</kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
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
              className="inline-flex items-center gap-2 px-6 py-3 rounded-[12px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer
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
  agents: 'Chat with & configure your AI agents',
  schedules: 'Automated task schedules',
  memory: 'Long-term agent memory store',
  tasks: 'Task board for orchestrator jobs',
  secrets: 'API keys & credentials for orchestrators',
  providers: 'LLM providers & custom endpoints',
  skills: 'Reusable instruction sets for agents',
  connectors: 'Chat platform bridges (Discord, Slack, etc.)',
  webhooks: 'Inbound HTTP triggers for event-driven workflows',
  mcp_servers: 'Connect agents to external MCP tool servers',
  knowledge: 'Shared knowledge base accessible by all agents',
  logs: 'Application logs & error tracking',
  plugins: 'Extend agent capabilities with custom plugins',
  usage: 'Token usage analytics & cost tracking',
  runs: 'Live session run monitoring & history',
}

const FULL_WIDTH_VIEWS = new Set<AppView>([
  'schedules', 'secrets', 'providers', 'skills',
  'connectors', 'webhooks', 'mcp_servers', 'knowledge', 'plugins',
  'usage', 'runs', 'logs',
])

const VIEW_EMPTY_STATES: Record<Exclude<AppView, 'agents'>, { icon: string; title: string; description: string; features: string[] }> = {
  schedules: {
    icon: 'clock',
    title: 'Schedules',
    description: 'Automate recurring tasks by scheduling orchestrators to run on a cron, interval, or one-time basis.',
    features: ['Set up cron expressions for precise timing', 'Run orchestrators automatically on intervals', 'Schedule one-time future tasks', 'View execution history and results'],
  },
  memory: {
    icon: 'database',
    title: 'Memory',
    description: 'Long-term memory store for AI agents. Orchestrators can store and retrieve knowledge across sessions.',
    features: ['Agents store findings and learnings automatically', 'Full-text search across all stored memories', 'Organized by categories and agents', 'Persists across sessions for continuity'],
  },
  tasks: {
    icon: 'clipboard',
    title: 'Task Board',
    description: 'A Trello-style board for managing orchestrator jobs. Create tasks, assign them to orchestrators, and track progress.',
    features: ['Kanban columns: Backlog, Queued, Running, Completed, Failed', 'Assign tasks to specific orchestrator agents', 'Sequential queue ensures orchestrators don\'t conflict', 'View results and session logs for completed tasks'],
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
    features: ['Connect Discord, Telegram, Slack, or WhatsApp bots', 'Route incoming messages to any agent', 'Each platform channel gets its own session', 'Start and stop connectors from the UI'],
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
    description: 'Connect agents to external MCP (Model Context Protocol) servers, injecting their tools into chat sessions.',
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
    description: 'Track token usage and costs across all providers and sessions.',
    features: ['Per-provider cost breakdown', 'Token usage over time', 'Session-level cost tracking', 'Export usage data'],
  },
  runs: {
    icon: 'activity',
    title: 'Runs',
    description: 'View the session run queue and execution history.',
    features: ['Monitor queued and running tasks', 'View run results and errors', 'Cancel pending runs', 'Automatic retry tracking'],
  },
}

function ViewEmptyState({ view }: { view: AppView }) {
  if (view === 'agents') return null
  const config = VIEW_EMPTY_STATES[view as Exclude<AppView, 'agents'>]
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
        <span className="truncate">{label}</span>
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
          Create a new session to start chatting
        </p>
        <button
          onClick={() => setNewSessionOpen(true)}
          className="inline-flex items-center gap-2.5 px-12 py-4 rounded-[16px] border-none bg-[#6366F1] text-white text-[16px] font-display font-600
            cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
            shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Session
        </button>
      </div>
    </div>
  )
}
